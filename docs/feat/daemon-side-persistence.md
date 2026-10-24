# feat/daemon-side-persistence — `serve` persists session history on its own host

> **Status:** DONE — merged to `main` 2026-10-20 (one fresh-context review: REQUEST-CHANGES, findings 1–8 addressed, not re-reviewed by owner choice). Part A only; Part B lives in `docs/feat/suspended-turn-resume.md`
> **Branch:** `feat/daemon-side-persistence`
> **Type:** feat · **Size:** M (Part A) · **Blast:** load-bearing (persistence + pod-trust invariants, steering window, AGENTS §7 rule change) · **Suited:** strong model executes; mandatory fresh-context Review

> **Superseded in part by `docs/feat/session-archive.md` (2026-10-24): close archives; delete removes.**
> Below, "close deletes the record" (Open question 5, the `close` row of the
> write table, A9) is no longer true. A close — and the reaper's, and the
> detached cap's eviction — writes the record once more stamped `archivedAt`
> (`DAEMON_RECORD_VERSION` 2) and keeps it; `serve` indexes archived records at
> start without restoring them; `session/open{reopen: true}` reloads one
> through the same `restore` path as a restart; `session/delete` is the only
> removal. A v1 record reads as a live v2 one.

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

### Revision for Part A, verified on `main` @ `e3c3293` (2026-10-20)

*— claude-opus-5-5, 2026-10-20*

The draft below (2026-10-19) was written on `4914e9b`, before seven of its
prerequisites landed (wire classes, turn events, history cut, registry,
TTL/limits, compact guard, store durability). This revision re-verifies it
against the code as built. **Where it disagrees with the draft, this revision
wins.** The [B] items of the draft stay where they are as the source for
`docs/feat/suspended-turn-resume.md`.

#### Load-bearing assumption

> **Persisting adds no `await` to the steering window.** Every daemon write is
> captured synchronously, and the turn-end write sits inside code that cannot
> await.

Verified:
- `HostedSession.finishTurn` is a plain (non-`async`) method
  (`hosted-session.ts:472-488`). `drive` calls it synchronously in the loop body
  on the agent's `turn_end` event, before the `return` that resumes the
  generator (`:420-423`). A `schedule(...)` call placed inside it cannot
  introduce an `await`.
- `schedule`'s own work runs synchronously up to the first `await` of the
  write. The chain is `JsonSessionStore.save` (sync until it returns its
  promise, `session-store.ts:251-264`) → `pump` → `writeAtomic` → the first
  `await mkdir` (`:296`). So the turn-end write costs one shallow copy, not
  I/O.
- **Correction to the draft (A2, "Why `schedule` returns `void`"):** `await` on
  a `void` call is *not* a type or lint error (TS allows `await undefined`, and
  Biome has no floating-promise rule here). The real guard is the one above:
  the call site is a synchronous function.
- Empirical proof: test P4 (below) copies the macrotask probe
  (`integration.test.ts:525-557`) with a store whose `save` never resolves. It
  must still see `{running: false, ended: true}` at the next macrotask, and it
  must fail under the mutation "`drive` awaits `persister.flush` before
  `finishTurn`".

#### What changed since the draft (verified, `file:line` on `e3c3293`)

1. **Open question 2 (epoch) is already solved.** `HostedSession` mints a fresh
   epoch per incarnation (`hosted-session.ts:156-163`), and `replayFrom`
   resyncs on any foreign epoch (`:271-279`). A restored session is a new
   incarnation, so no token work is needed. Test P8 pins it.
2. **Idempotency maps exist and are in memory:** `turns: Map<turnId, {end?}>`
   (`:119`) and `enqueued: Set` (`:121`). Both are persisted (Open question 3).
   The turn interrupted by a restart gets a cached end, so a retried
   `prompt{turnId}` answers `{turnId, ended}` and never runs again (`:370-373`).
3. **`configDir` is global** (`config/src/load.ts:157`, `~/.config/tentacle`).
   The draft's `<configDir>/daemon/sessions/` would make two `serve`s on two
   projects fight over one lock. Worse, a `serve` in project B would reload
   project A's sessions and run them confined to B's cwd (`session-host.ts:179`
   ignores the record's cwd). **Fix:** one store per project,
   `<configDir>/daemon/<projectKey(cwd)>/`, with `projectKey` =
   `<basename>-<sha256(realpath(cwd))[:12]>`. This is the derivation
   `docs/eval/session-store-per-project.md` §Review 1 recommends for the client
   store; it lives in `@tentacle/agent` so that fix can reuse it. A record whose
   `cwd` is not `config.cwd` is skipped anyway (defence in depth).
4. **The requester routes to the most recent attachment, or denies at once when
   none is attached** (`hosted-session.ts:169-177`, the interim routing until
   `permission-events`). So a "suspension" exists only while a request is
   outstanding to an attached client. The pending record is set only on that
   path.
5. **Store durability as built** (`session-store.ts`): `save` is
   serialized/latest-wins and rejects on failure (`:244-264`). `list()` returns
   `{records, skipped}` (`:384-408`). Extra top-level fields are kept, but extra
   *message* keys are rejected (`:138,149-152`). There is **no delete** yet, so
   `JsonSessionStore.remove(id)` is added (drops a queued write, waits for the
   running one, then `rm`).
6. **There is no `onCommitted()`.** The cut moves in `drive` on the agent's
   `history_commit` (`:426-429`), in `finishTurn` (`:486`) and in the
   compaction barrier `historyReplaced` (`:553-569`). Those are the committed
   boundaries. `Session.onPersist` is not wired on the daemon
   (`session-host.ts:181`), and every daemon path goes through `HostedSession`,
   so it stays unwired.
7. **The prompt is in the history synchronously** once `prompt()` has called
   `void this.drive(...)`: the async generator body runs up to its first
   `await` within the first `next()` (`session.ts:62-70`). Repro
   `.tentacle/tmp/daemon-side-persistence/turnstart.ts` prints
   `raw history after prompt() returned: ["user:PROMPT"]`. So the turn-start
   write goes right after `void this.drive(...)`, and test A1 pins that it
   holds the prompt.

#### Design decisions that differ from the draft

- **D-a. The pending record is durably cleared before an approved tool runs,
  already in Part A** (the draft deferred this to B4). Part A tells the model
  "Not run" for a pending call, and that claim is only true if a call that was
  approved and then started can never still read as pending on disk. The
  requester wrapper therefore, on settle, clears `pending`, calls `schedule`,
  and `await`s `persister.flush(id)` before returning to the gate. This is
  mid-round, inside `authorize`, far from the steering window. A flush failure
  is logged and the tool still runs (the user approved it). The residual case,
  a crash right after such a failure, is written up under Failure modes.
- **D-b. Every acked `enqueue` on `serve` is on disk** (the draft only waited
  when the turn was suspended). The push stays synchronous; only the ack waits,
  in `Connection` (`connection.ts` enqueue). The cost is one local fsync on a
  user-typed message. A **write failure does not fail the ack**: the steer *is*
  queued and is delivered while the daemon lives. The failure goes to the
  daemon log like every other store failure, so failures are never RPC errors.
  (The draft's `PersistFailed` error would collide with idempotency: a retry
  with the same id is a dedupe no-op success.) `flush` never rejects.
- **D-c. A file that could not be loaded is never overwritten or deleted.**
  The ids of skipped files (unreadable, wrong `kind`, unknown `schemaVersion`,
  foreign `cwd`) are *blocked* in the persister. If a client later opens that
  uid, the session lives in memory only, and one log line says why.
- **D-d. The interrupted turn's cached end** is
  `{stopReason: "error", error: {code: DaemonRestarted, message: "interrupted: the daemon restarted during this turn"}}`.
  This adds one `DomainErrorCode` (`-32012`) to `@tentacle/protocol`, which is
  additive: an old client sees an unknown number plus the message, so
  `PROTOCOL_VERSION` stays. `schema/protocol.json` is regenerated
  (`bun run schema:export`; the drift gate pins it).
- **D-e. The TTL clock on reload** (pure `restoredActivity`): a record written
  while idle → its `lastActiveAt` (exact: nothing ended since). A record
  written mid-turn → *now*: the session was busy until the crash, at an unknown
  time ≤ now, and erring on "keep it longer" never destroys data. Expired
  sessions are left to the reaper's first sweep, so there is one teardown path
  (`session-host.ts:154-171`).
- **D-f. Shutdown:** `SIGINT` → stop the reaper and the server →
  `persister.stop()` (stop accepting writes, then drain) → release the lock →
  exit. A second `SIGINT` exits at once, so a hung disk cannot trap the user
  (today a handler is installed, so Ctrl+C never kills `serve` by default,
  `main.ts:239-242` on `e3c3293`). Sessions are **not** closed on shutdown: surviving a
  restart is the point.
- **D-g. A session is written once when created** (the constructor), so a
  session seeded by `open{messages}` survives a restart before its first turn.

#### Preconditions (re-verified)

P1–P3 and P5–P8 of the draft hold on `e3c3293`, with the line numbers moved:
- **P1** pushes: `agent.ts:215,268-272,300,314,330,360,384,424,439`;
  `history_commit` after each push that commits (`:281,341,362`).
- **P2** sequential calls: `agent.ts:323-363`.
- **P3** steering in `Session` (`session.ts:32,65,83-85`). The running/turn
  check is in `HostedSession.enqueue` (`hosted-session.ts:496-509`).
- **P4** the steering invariant: `agent.ts:287-296`, `hosted-session.ts:410-417`,
  pinned by `integration.test.ts:525-557`.
- **P5** `serve` alone builds its host in `startDaemon` (`serve.ts:56-98`).
  `startStdioDaemon` (`:109-183`) and the worker (`worker.ts:87`) build their
  own hosts, without a persister.
- **P6** the client store is `<configDir>/sessions` (`main.ts`), separate from
  `<configDir>/daemon/<key>/`.
- **P7** `agent_task` never asks for permission (`tools/src/task.ts`).
- **P8** `ChatMessage` round-trips through JSON.
- **New P9:** `PermissionRequest.tool` is the tool's name
  (`core/src/permission.ts:16`), which `classifyPending` compares with the
  current call's name.

#### Files (dependency order)

1. `packages/protocol/src/jsonrpc.ts`: `DaemonRestarted: -32012`, plus the
   regenerated `packages/protocol/schema/protocol.json`.
2. `packages/agent/src/session.ts`: `pendingSteering(): readonly string[]`.
3. `packages/agent/src/session-store.ts`: `JsonSessionStore.remove(id)` and
   `projectKey(cwd)`.
4. `packages/daemon/src/persisted-session.ts` (new, pure):
   `DaemonSessionState`, `DaemonSessionRecord`, `toDaemonRecord`,
   `parseDaemonRecord`, `classifyPending`, `reconcileOnReload`,
   `restoredActivity`, and the note texts.
5. `packages/daemon/src/session-persister.ts` (new): `SessionPersister`
   (`schedule` / `flush` / `remove` / `block` / `stop`) over a minimal
   `RecordStore` interface, plus `acquireStoreLock`.
6. `packages/daemon/src/hosted-session.ts`: an optional 8th parameter
   `persistence?: {persister, restored?}`; the write sites; the pending
   capture; `persisted()`.
7. `packages/daemon/src/session-host.ts`: a `persister?` option, `restore()`,
   and `remove` on `close` (which covers the reaper too).
8. `packages/daemon/src/connection.ts`: `enqueue` acks after `persisted()`.
9. `packages/daemon/src/index.ts`: the exports.
10. `packages/cli/src/serve.ts`: an `async startDaemon` that does
    store dir → lock → list → restore → listen, and returns
    `{url, port, stop(): Promise<void>}`.
11. `packages/cli/src/main.ts`: `await startDaemon`, the notices printed before
    listening, and the two-stage SIGINT.
12. `AGENTS.md` §7: the amendment (draft A9, adjusted to the per-project
    directory).

#### Write sites (all synchronous `schedule`; none awaited in a turn)

| Site | Where | Captures |
|---|---|---|
| creation / restore | `HostedSession` constructor | the seeded or reconciled history |
| turn start | `prompt()`, after `void this.drive(...)` | the prompt in the history, `turn.turnId`, the `turns` entry |
| committed boundary | `drive` on `history_commit`, after `recordCut` | each round's assistant message and each tool result |
| suspension | requester wrapper, before forwarding | `turn.pending` |
| permission settled | requester wrapper, then `await flush` (D-a) | `pending` cleared |
| enqueue | `HostedSession.enqueue` after the push; `Connection` awaits `persisted()` (D-b) | `turn.steering`, `enqueueIds` |
| turn end | `finishTurn`, in its `finally` after `recordCut` (sync) | no `turn`; `turns[turnId].end` |
| compaction | `compact()`'s `finally`, once the slot is free (review fix) | the compacted history and its clock |
| detach | `removeAttachment` (review fix, R1) | the TTL clock (`lastActiveAt`/`lastDetachAt`) |
| close | `SessionHost.close` → `persister.remove(id)` | file deleted (skipped if blocked) |

After `close()` (the `closed` flag) every `schedule` is a no-op, so a `remove`
can never be followed by a resurrecting write.

#### Reconciliation on reload (pure, `reconcileOnReload`)

- **No `turn`** → the history is used as is.
- **`turn` present** → every unanswered call of the trailing assistant
  message is answered in order, right after the existing answers:
  - the first unanswered call:
    - is the `pending` one and the request came from that call → **"Not run"**;
    - is the `pending` one but the request came from a sub-agent
      (`resumable: false`, D4) → **sub-agent interrupted**;
    - there is no `pending`, or `pending` names some other call → **"Interrupted
      … may or may not have completed"** (the conservative reading);
  - every later unanswered call → **"Not run"**.

  `turn.steering` entries are then appended as `user` messages, and the turn's
  `turns` entry gets the D-d end unless it already has one.

#### Failure modes (delta to the draft's table; the rest of it holds)

| Case | Outcome |
|---|---|
| Flush fails after an approval, then the daemon crashes while the tool runs | The disk still says pending, so the reload says "Not run" for a call that may have run. This needs two failures (disk + crash) inside one tool run; it is logged at the flush failure. Documented limit. |
| A client opens a uid whose file was skipped | The session lives in memory only, with one log line (D-c). The file is left byte-identical. |
| `serve` started in another project | It uses another directory and another lock, so it neither collides nor reloads foreign sessions. |
| A record with a foreign `cwd` in the directory | Skipped, reported, blocked (D-c). |
| `close` / reap racing a write | `remove` drops the queued write and waits for the running one before `rm`, and `closed` stops new writes. |
| Shutdown while a turn runs | Writes stop being accepted, the pending ones drain, and the last record has `turn`, so it is reconciled at the next start. |
| Store write fails (ENOSPC/EACCES) | `onError` → `[daemon] error: couldn't write …`. The session serves from memory and the next `schedule` retries. Never an unhandled rejection. |
| Two `serve`s on one project | The second refuses, naming the pid and the lock file. A dead pid's lock is taken over once. **Limit (review nit 7):** two daemons starting in the same instant over one *stale* lock can both take it over (`rm` + exclusive create is not atomic as a pair, and Bun/Node have no `flock`). It needs a crashed holder plus two simultaneous starts; documented, not fixed. |

#### Tests (red first; each names its mutation)

`packages/daemon/test/persistence.test.ts` (a `SpyStore` with `release()` and
`durable`, a scripted model, the real `Agent`/`Session`/`PermissionGate`), plus
`packages/agent/test/session-store.test.ts` (the new `remove`/`projectKey`)
and `packages/cli/test/serve-persistence.test.ts` (a real disk under a temp
`configDir`):

- **A1** The turn-start record holds the prompt and the `turns` entry.
  Mutation: write before `drive` starts → prompt missing.
- **A2** A restart after `turn_end` → the snapshot deep-equals the history from
  before; the session is detached and idle.
- **A3** A restart mid-suspension on `c2` of `[c1 none, c2 ask, c3 ask]`, with
  `steer-1` enqueued → `tool(c1), tool(c2 "Not run"), tool(c3 "Not run"), user
  steer-1`; no exec. Mutation: every unanswered call labelled "Interrupted" →
  fail.
- **A4** A crash mid-tool (no pending) → "Interrupted" + "Not run"; nothing
  re-runs.
- **A5** A sub-agent-shaped pending → the sub-agent note (D4).
- **A6** Pending is durable *before* the tool runs (D-a): the tool's `execute`
  reads `SpyStore.durable` and must see no `pending`. Mutation: drop the flush
  → fail.
- **A7** An enqueue ack waits for the disk (D-b): the ack does not resolve
  before `release()`, and afterwards `durable.turn.steering` holds the text.
  Mutation: drop the await → fail.
- **P4** The steering invariant with a never-resolving store (see the
  load-bearing assumption).
- **A8** Idempotency across a restart: `prompt{T}`, then a restart, then
  `prompt{T}` → `{turnId: T, ended: {error.code: DaemonRestarted}}`, and the
  model is not called. Mutation: do not persist `turns` → it runs again.
- **P8** A pre-restart `since` against the restored session → `resync: true`.
- **A9** `close` removes the file; a write scheduled before the close does not
  resurrect it. The reaper's close removes it too.
- **A10** A store failure → `onError`, no `unhandledRejection`, and the turn
  completes.
- **A11** Bad records (truncated, wrong `kind`, `schemaVersion: 2`, foreign
  `cwd`) → skipped, reported, byte-identical. Opening such a uid never writes
  the file. The valid records still load.
- **A12** Lock: a second `startDaemon` on the same `configDir`/cwd refuses with
  the pid. A dead pid is taken over. Another cwd is not affected.
- **A13** End to end over a real disk: `startDaemon` → a turn → `stop()` → a
  new `startDaemon` → `session/open{sessionId}` → the snapshot equals the
  history. A `SessionHost` without a persister writes nothing (pods/worker).
- **A14** `pendingSteering` returns a copy; `classifyPending` is false when the
  tool differs (the sub-agent shape), and `agent_task` stays
  `permission: "none"` (P7).

---

### Original draft (2026-10-19) — superseded above where they differ; [B] items are the source for `suspended-turn-resume`

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (steering-over-rpc merged). Cited lines
are on that commit. The earlier v2 children (`session-event-stream`,
`session-registry`, `session-ttl-limits`, `permission-events`,
`session-store-durability`) are **not implemented yet**. Where this plan leans on
them, it names the interface it assumes (§ *Assumed interfaces*) and does not
redesign it.

### Open questions / contradictions (owner decisions needed before Execution)

1. **Ordering contradiction: rebuilding a suspension needs `permission-events`,
   which is scheduled *after* this child.** On restart the rebuilt turn re-runs
   `gate.authorize`, which calls the session's requester
   (`permission-gate.ts:74`). Until `permission-events` lands, that requester is
   a daemon→client request bound to one connection (`hosted-session.ts:48-52`,
   `connection.ts:222-232`). After a restart no connection exists, so the
   request fails and is coerced to `cancelled`, which is a **deny**
   (`connection.ts:228-231`). That violates the owner rule "a denial only ever
   comes from a person". `permission-events`' own scope already says it
   rebuilds the suspension on restart, and the parent table makes it depend on
   this child only for that point. **Recommendation:** split this child in two:
   - **Part A, `daemon-side-persistence` (this doc, M, stays at step 6, before
     `permission-events`).** It adds the daemon store, writes at every committed
     boundary, reload-as-detached on startup, the record format *including* the
     pending-permission record and the steering queue, the store lock, pods
     unchanged, and the AGENTS §7 amendment. A turn that was suspended at a
     restart is **reconciled honestly, not resumed**: the pending call is answered
     with "not run: the daemon restarted while this was waiting for your
     approval", queued steers are kept as user messages, and the session reloads
     idle. Nothing is denied on the user's behalf and nothing runs.
   - **Part B, `suspended-turn-resume` (new doc, M, after `permission-events`).**
     It adds the agent-loop resume seam, `Session.resume`, rebuilding the
     suspension so the gate re-asks through the event-based requester (new
     nonce), and the await-before-run clear of the pending record.
     `permission-events` then drops its "survives restart" bullet, which moves to
     Part B.

   Part B is fully planned below (marked **[B]**), so the split is only a doc
   move: an executor creates `docs/eval/suspended-turn-resume.md` (promoted 2026-10-20: `docs/feat/suspended-turn-resume.md`) from the [B]
   items. *Alternative:* keep one task. It is then **L** (agent + daemon + cli
   + AGENTS.md, two packages of tests) and must move after `permission-events`.
   That works too, but it delays the store, which `permission-events` does not
   need.
2. **The `since` token must not survive a restart unchanged.** The ring and
   `seq` are in memory (`hosted-session.ts:32-34`), so a restarted daemon
   starts counting again. A client returning with `since = 500` from before the
   restart would then get either a "future" token (resync, fine) or, once the
   new daemon has passed 500, a valid-looking token whose replay **skips** new
   events that reuse old seq numbers (the client dedupes them by seq). This is a
   silent gap. **Recommendation:** `session-event-stream` makes `since` opaque.
   This child adds a per-process **boot epoch** (random, minted at `serve`
   start) to the token (`<epoch>.<seq>`). Any epoch mismatch → `resync`. This
   adds a field to an opaque token and does not redesign it. Persisting `seq`
   instead would not work: events after the last write would be re-numbered.
3. **Idempotency keys must be persisted too.** `session-event-stream` keeps
   `turnId → ack` (and `enqueue` ids) for the session's lifetime (review F8).
   If that map lives only in memory, a phone that retries `prompt{turnId}` after
   a restart **runs the turn twice**, which is exactly F8, moved one layer down.
   **Recommendation:** the record carries both id sets (a few bytes per turn).
   This is in scope here.
4. **"Allow always" grants (`PermissionGate.grantedTools` / `shellPrefixes`,
   `permission-gate.ts:55-58`) are memory-only.** After a restart the user is
   re-asked for commands they had approved for the session. This fails safe
   (more prompts, never fewer). **Recommendation:** do not persist grants in this
   task. Persisting them needs a gate export/import API and its own pod-trust
   review. Open a follow-up if the re-prompts annoy.
5. **What `session/close` does to the daemon record.** **Recommendation:**
   `close` deletes it. The daemon copy exists to keep *live* sessions alive
   across a restart, and the client keeps its own copy (Review: offline viewing,
   `open{messages}` recovery). Without deletion, `<store>/` grows forever with
   sessions nobody can reach without re-opening them.
6. **Sub-agent suspensions are not resumable (both parts).** A permission
   requested *inside* an `agent_task` sub-agent comes from the child's own loop.
   The child shares the parent's broker (`wiring.ts:124`) and its history lives
   only in the child's memory (`subagent.ts`). A restart cannot rebuild it
   without re-running the sub-agent, and its tools may already have had side
   effects. **Recommendation:** on reload, answer the `agent_task` call with an
   explicit "interrupted by a daemon restart while a sub-agent waited for
   approval; its partial work is lost". The session reloads idle, and the
   suspension is lost *visibly*. Persisting child conversations is a separate L
   item. **The owner should confirm** that this exception to "the suspension
   survives a restart" is acceptable.
7. **Dependency on `session-store-durability`.** This plan reuses
   `JsonSessionStore`. That store's `save` writes in place today
   (`session-store.ts:63-66`), a crash mid-write truncates the file, and `load`
   swallows parse errors (`:69-79`). A daemon that writes on *every* boundary
   multiplies that crash window. **Recommendation:** make
   `fix/session-store-durability` (atomic rename, serialized latest-wins
   queue, validated loud load) a **hard prerequisite** of Part A, not something
   re-implemented here (Review: one durability implementation).

### Load-bearing assumption

> The history persisted at the moment the permission is requested, plus
> `{pendingToolCallId, steering}`, is enough to rebuild the suspended turn
> **without re-running the model round**: the rebuilt turn re-asks for exactly
> the call the user was looking at, runs the rest of that round's calls, and
> then continues the loop. The final history is byte-identical to an
> uninterrupted run.

**Verdict: the data is sufficient. The loop cannot resume mid-round today, so a
minimal agent-loop change is needed (Part B).**

Code facts:
- **The assistant message, with all its `toolCalls`, is committed before any
  tool is authorized.** It is pushed at `agent.ts:256-260`. The per-call loop
  follows at `:304-341`, and authorization sits inside `runTool`
  (`:333` → `:486-500`, `gate.authorize` at `:495`). Each answered call's
  `tool` message is pushed at `:340` before the next call's `tool_start`
  (`:324`). So while call *k* waits in `authorize`, `messages` =
  `…, assistant{toolCalls: c1..cn}, tool(c1) … tool(c_{k-1})`, which is
  exactly what has happened and nothing more.
- **Nothing besides history determines the decision.** `authorize`
  (`permission-gate.ts:63-79`) depends only on the tool, its parsed input, and
  the in-memory grants (`:70-72`). It keeps no per-request state that a re-ask
  would need. Re-asking means calling `authorize` again with the same
  `(tool, input)`, and `input` is re-parsed from the stored `call.arguments`
  (`agent.ts:489-494`).
- **The daemon sees the suspension synchronously, with the right call id.**
  `HostedSession` sets `currentToolCallId` on the `tool_start` event
  (`hosted-session.ts:101-103`) before the generator resumes into `runTool`. So
  the requester wrapper (`:48-52`) knows the call id and can copy
  `session.snapshot()` (`session.ts:46-48`) at that moment.
- **But `runMessages` always starts with a model round** (`agent.ts:195-217`).
  It cannot be entered "at call *k*". Today's only re-entry,
  `Session.send("")` (`session.ts:62-76`), sends the dangling
  `assistant{c1..cn}` back to the model and never runs `c2..cn`. That is the
  unwanted re-ask: an extra model round, and the approval the user saw no longer
  matches what runs.

**Experiment** (`.tentacle/tmp/daemon-side-persistence-impl/resume.ts`,
2026-10-19, bun 1.4.3). It uses a real `Agent` + `Session` + `PermissionGate` +
`ToolRegistry(builtinTools)`, a scripted model, and a fake env. Round 1 asks
for `c1 fs_read` (permission `none`), `c2 shell "echo two"` (`ask`) and
`c3 shell "echo three"` (`ask`); round 2 answers in text. A steer is enqueued
while `c2` is pending.

```ts
// Load-bearing assumption: persisted history + {pendingToolCallId, steering}
// captured AT the permission request is enough to rebuild the suspended turn
// WITHOUT re-running the model round. Real Agent + Session + PermissionGate +
// ToolRegistry; scripted model; fake env.
import { Agent, PermissionGate, Session } from "@tentacle/agent";
import type { ChatMessage, ChatRequest, ExecutionEnvironment, ModelProvider, PermissionRequest, StreamEvent } from "@tentacle/core";
import { ToolRegistry, builtinTools } from "@tentacle/tools";

const ROUND1: StreamEvent[] = [
  { type: "tool_call", toolCall: { id: "c1", name: "fs_read", arguments: JSON.stringify({ path: "a.txt" }) } },
  { type: "tool_call", toolCall: { id: "c2", name: "shell", arguments: JSON.stringify({ command: "echo two" }) } },
  { type: "tool_call", toolCall: { id: "c3", name: "shell", arguments: JSON.stringify({ command: "echo three" }) } },
  { type: "done" },
];
const ROUND2: StreamEvent[] = [{ type: "text", delta: "all done" }, { type: "done" }];

class Scripted implements ModelProvider {
  readonly id = "scripted";
  calls: ChatRequest[] = [];
  constructor(private readonly script: StreamEvent[][]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    for (const e of this.script[this.calls.length - 1] ?? [{ type: "done" }]) yield e as StreamEvent;
  }
}
function env(execs: string[]): ExecutionEnvironment {
  return {
    id: "fake",
    async exec(c: string) { execs.push(c); return { stdout: `ran ${c}`, stderr: "", exitCode: 0 }; },
    async readFile() { return "A-CONTENT"; },
    async writeFile() {},
  } as ExecutionEnvironment;
}
const tools = () => new ToolRegistry().registerAll(builtinTools);
const roles = (m: readonly ChatMessage[]) =>
  m.map((x) => x.role === "assistant" && x.toolCalls ? `assistant[${x.toolCalls.map((t) => t.id)}]` : x.role === "tool" ? `tool(${x.toolCallId})` : `${x.role}:${JSON.stringify(x.content).slice(0, 24)}`).join(" -> ");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- A. uninterrupted reference run (steer enqueued while c2 is pending) ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND1, ROUND2]);
  let session!: Session; const prompts: string[] = [];
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: async (r: PermissionRequest) => {
    prompts.push(String(r.detail)); if (r.detail === "echo two") { session.enqueue("steer-1"); await tick(); } return { allowed: true }; } });
  session = new Session(agent, "S");
  for await (const _ of session.send("go")) {}
  console.log("A uninterrupted: model calls =", model.calls.length, "| prompts =", prompts, "| execs =", execs);
  console.log("A history:", roles(session.messages));
  (globalThis as any).A = JSON.stringify(session.messages);
}

// ---------- B. suspend on c2, capture record, abandon process state, rebuild ----------
let record: { messages: ChatMessage[]; pendingToolCallId: string; steering: string[] };
{
  const execs: string[] = []; const model = new Scripted([ROUND1, ROUND2]);
  let session!: Session; let current = "";
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: (r: PermissionRequest) => {
    // The daemon's requester sees the exact suspension state, synchronously:
    record = { messages: JSON.parse(JSON.stringify(session.snapshot().messages)), pendingToolCallId: current, steering: [] };
    return new Promise(() => {}); // suspended forever (the "process" dies here)
  } });
  session = new Session(agent, "S");
  const gen = session.send("go");
  (async () => { for await (const e of gen) { if (e.type === "tool_start") current = e.id; } })();
  await tick(); await tick();
  session.enqueue("steer-1"); // accepted while suspended
  record!.steering = [...(session as any).steering]; // re-written on every enqueue while suspended
  console.log("\nB before restart: model calls =", model.calls.length, "| execs =", execs);
  console.log("B record.pendingToolCallId =", record!.pendingToolCallId, "| steering =", record!.steering);
  console.log("B record.messages:", roles(record!.messages));
}

// ---------- B'. TODAY's only entry: Session.send("") over the restored history ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND2]);
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: async () => ({ allowed: true }) });
  const s = new Session(agent, "S", { messages: JSON.parse(JSON.stringify(record!.messages)) });
  for await (const _ of s.send("")) {}
  console.log("\nB' today (send \"\"): model calls =", model.calls.length, "| execs =", execs,
    "| 1st request:", roles(model.calls[0]!.messages));
}

// ---------- B''. PROTOTYPE of the proposed seam: run pending calls, THEN the loop ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND2]); const prompts: string[] = [];
  const requester = async (r: PermissionRequest) => { prompts.push(String(r.detail)); return { allowed: true }; };
  const reg = tools(); const e = env(execs);
  const agent = new Agent({ model, tools: reg, env: e, requestPermission: requester });
  const messages: ChatMessage[] = JSON.parse(JSON.stringify(record!.messages));
  const steering = [...record!.steering];
  // what `runMessages(..., { resumeFrom })` would do before its first model round:
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const answered = new Set(messages.slice(last + 1).map((m) => m.toolCallId));
  const calls = messages[last]!.toolCalls!;
  const from = calls.findIndex((c) => c.id === record!.pendingToolCallId);
  const gate = new PermissionGate(requester);
  for (const call of calls.slice(from)) {
    if (answered.has(call.id)) continue;
    const tool = reg.get(call.name)!;
    const ok = await gate.authorize(tool, JSON.parse(call.arguments));
    const res = ok ? await reg.execute(call.name, call.arguments, { sessionId: "S", signal: new AbortController().signal, env: e }) : { content: "denied" };
    messages.push({ role: "tool", content: res.content, toolCallId: call.id });
  }
  for await (const _ of agent.runMessages(messages, "S", undefined, () => steering.splice(0))) {}
  console.log("\nB'' resumed: model calls =", model.calls.length, "| prompts =", prompts, "| execs =", execs);
  console.log("B'' 1st request:", roles(model.calls[0]!.messages));
  console.log("B'' history == A history:", JSON.stringify(messages) === (globalThis as any).A);
}
process.exit(0);
```

Output:

```
A uninterrupted: model calls = 2 | prompts = [ "echo two", "echo three" ] | execs = [ "echo two",
  "echo three"
]
A history: user:"go" -> assistant[c1,c2,c3] -> tool(c1) -> tool(c2) -> tool(c3) -> user:"steer-1" -> assistant:"all done"

B before restart: model calls = 1 | execs = []
B record.pendingToolCallId = c2 | steering = [ "steer-1" ]
B record.messages: user:"go" -> assistant[c1,c2,c3] -> tool(c1)

B' today (send ""): model calls = 1 | execs = [] | 1st request: user:"go" -> assistant[c1,c2,c3] -> tool(c1)

B'' resumed: model calls = 1 | prompts = [ "echo two", "echo three" ] | execs = [ "echo two",
  "echo three"
]
B'' 1st request: user:"go" -> assistant[c1,c2,c3] -> tool(c1) -> tool(c2) -> tool(c3) -> user:"steer-1"
B'' history == A history: true
```

What it shows:
- **The record captured at the request is exact** (B). It holds
  `assistant[c1,c2,c3] -> tool(c1)`, pending = `c2`, and the steer accepted
  during the suspension.
- **Today's re-entry is wrong** (B'). The model is called over a history with
  two unanswered calls, and `c2`/`c3` never run.
- **"Run the unanswered calls from the pending one, then enter the loop" is
  correct** (B''). `c1` is not re-run. `c2` and `c3` are each asked once and
  each run once. The steer is drained at the first iteration top, where it
  would have been drained anyway (`agent.ts:201-205`). There is one model
  round after the restart (1 before + 1 after = 2, the same as A), and the
  final history is **identical** to A.

### Preconditions

- **P1: history is shared by reference and committed per push.** `Session`
  passes its own `messages` array to `runMessages` (`session.ts:70`). The loop
  pushes into it (`agent.ts:203,256,282,296,311,340,363,402,417`), and `snapshot()` copies
  it (`session.ts:46-48`). Any synchronous snapshot is a well-defined prefix of
  the turn.
- **P2: tool calls run sequentially.** This is the `for` loop at
  `agent.ts:304-341`, so at most one call is in `authorize` at a time. The
  "calls before the pending one are answered" check depends on this. If
  `docs/eval/parallel-tool-calls.md` lands, revisit P2.
- **P3: the steering queue lives in `Session`.** It is private
  (`session.ts:32`), `send` resets it (`:65`), `enqueue` pushes to it
  (`:83-85`), and the loop drains it at each iteration top (`agent.ts:202`),
  at the late drain (`:279`) and in the final report (`:361,416`).
  `Connection.enqueue` is synchronous and rejects when no turn is running
  (`connection.ts:155-167`). A turn suspended on a permission is `running`
  (`hosted-session.ts:68-70`: the controller is set for the whole turn), so
  an enqueue is accepted while it waits.
- **P4: the steering invariant.** The comment is at `agent.ts:270-278`, and
  the test at `daemon/test/integration.test.ts:424-463` arms a macrotask in
  the last drain and asserts `running === false` when it fires. A turn
  awaiting a microtask is fine; awaiting I/O (a macrotask) between the last
  drain and the controller being cleared (`hosted-session.ts:113-115`) is not.
- **P5: `serve` and the pod daemon are separate entry points with separate
  `SessionHost`s.** They are `startDaemon` (`cli/src/serve.ts:28-43`, the ws
  `serve`, `main.ts:221-236`) and `startStdioDaemon` (`serve.ts:54-121`, the
  `serve --stdio` used inside pods, `main.ts:192-200`). The in-process worker
  builds a third host (`cli/src/worker.ts:80`). So "serve only" can be
  **structural**: only `startDaemon` passes a store. Nothing needs to detect
  the runtime.
- **P6: the client store dir is `<configDir>/sessions`** (`main.ts:269,452`).
  A `serve` on the same machine as a TUI shares `configDir`, and the client
  uses the same session uid (it owns the uid, AGENTS §7). The daemon store
  therefore needs its **own** directory, or two writers would race on one
  file (`session-store-durability` repro (e)).
- **P7: no tool has permission `ask` and also nests permission requests.**
  `agent_task` is `permission: "none"` (`tools/src/task.ts:52`), so any
  request raised while the current parent call is `agent_task` comes from a
  sub-agent. Classifying a pending request as resumable depends on this
  (Design A4). A test pins it.
- **P8: `ChatMessage` round-trips through JSON.** In the experiment,
  `JSON.parse(JSON.stringify(messages))` re-ran to an identical history,
  `toolCalls` included.
- **Store lock primitive (verified,
  `.tentacle/tmp/daemon-side-persistence-impl/lock.ts`, bun 1.4.3).**
  `openSync(path, "wx")` gives `EEXIST` on the second take, and
  `process.kill(pid, 0)` tells a live holder from a dead one:
  ```ts
  import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
  const path = `${import.meta.dir}/store.lock`;
  rmSync(path, { force: true });
  const take = (pid: number) => { const fd = openSync(path, "wx"); writeSync(fd, String(pid)); closeSync(fd); };
  take(process.pid);
  console.log("first take: ok");
  try { take(process.pid); } catch (e) { console.log("second take:", (e as NodeJS.ErrnoException).code); }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
  console.log("holder alive (self):", alive(Number(readFileSync(path, "utf8"))));
  const dead = Bun.spawnSync(["true"]).pid;
  console.log("holder alive (exited child):", alive(dead));
  rmSync(path);
  ```
  ```
  first take: ok
  second take: EEXIST
  holder alive (self): true
  holder alive (exited child): false
  ```

### Assumed interfaces (from unimplemented children — not redesigned here)

- **`session-store-durability`:** `JsonSessionStore.save` is atomic
  (temp + rename), serialized per uid with latest-wins coalescing, and
  rejects instead of crashing. `load` returns a validated record, or a typed
  *corrupt* result that is distinct from *absent*. `list` skips and reports
  bad files. Extra fields on a record are preserved verbatim, which this plan
  relies on to store `DaemonSessionRecord extends SessionRecord` in the same
  class.
  > **As built (2026-10-20, `docs/fix/session-store-durability.md`):** all of
  > the above holds (`save` rejects with `couldn't write <uid>.json: …`;
  > `load` → `ok | absent | unreadable`; `list` → `{records, skipped}`;
  > `drain()`). Two constraints for this plan: extra *record* fields are
  > preserved but extra *message* fields are rejected (the check mirrors the
  > strict wire `ChatMessageSchema`); and the daemon must handle every `save`
  > rejection itself (the laptop's `SessionSaver` is cli-side).
- **`session-event-stream`:** `HostedSession` has **one synchronous place**
  where it advances the consistent cut (`committedSeq`) after a history push
  (round end, each tool result, turn end, compaction via `history_replaced`).
  Call it `onCommitted()`. A turn driver separate from `prompt` emits
  `turn_start{turnId}` / `turn_end{turnId,…}` and clears the controller in one
  synchronous segment. There are lifetime idempotency maps for `turnId` and
  `enqueue.id`, and an opaque `since`.
- **`session-registry`:** `SessionHost` is the registry
  (`open/get/close`). `HostedSession` has a set of sinks and a `close()`. A
  live id is always attached, never overwritten. This plan adds one registry
  entry point, `restore(record)` (insert a detached live session), and one
  hook, `onClosed(id)`.
- **`session-ttl-limits`:** the reaper reads a per-session "last active"
  time and skips running or suspended turns. This plan supplies that time from
  the record on reload.
- **`permission-events`** (Part B only): the requester emits a
  `permission_request` event with a fresh nonce into the ring and resolves
  when any client answers. No timeout, no connection binding.

### Design

**Part A — `daemon-side-persistence` (this doc).**

A1. **Record format.** Add `DaemonSessionRecord` to
`daemon/src/persisted-session.ts`, a new pure module (validation + mapping, no
I/O):

```ts
interface DaemonSessionRecord extends SessionRecord {   // agent/src/session-store.ts:13-23
  readonly kind: "tentacle.daemon-session";
  readonly schemaVersion: 1;                              // of THIS record, independent of PROTOCOL_VERSION
  readonly lastActiveAt: number;                          // TTL clock (session-ttl-limits)
  readonly turnIds: readonly string[];                    // idempotency (Open question 3)
  readonly enqueueIds: readonly string[];
  readonly turn?: {                                       // present iff a turn was running at the write
    readonly turnId: string;
    readonly steering: readonly string[];                 // Session's queue, verbatim, in order
    readonly pending?: {                                  // present iff suspended on a permission
      readonly toolCallId: string;
      readonly tool: string;
      readonly resumable: boolean;                        // A4
      readonly requestedAt: number;
    };
  };
}
```

`parseDaemonRecord(json) → {ok, record} | {ok:false, reason}` checks `kind`,
`schemaVersion === 1`, and the field types. A different `schemaVersion`
returns `reason: "unsupported-version"`. Such a file is **never overwritten**
and is reported by name (Failure modes). Messages are stored as `ChatMessage`
JSON, the same as the client store (P8).

A2. **The persister: a write that can never be awaited in the turn.** Add
`daemon/src/session-persister.ts`:
- `schedule(id, build: () => DaemonSessionRecord): void` returns **`void`, not
  a Promise**, so an `await` on it is a type error under the repo's lint and
  cannot be written by accident in the end-of-turn window. `build` runs
  **synchronously** inside `schedule`: it copies `snapshot()` and the steering
  queue *now*, so the content is the cut at the call site, not at the later I/O.
  It then hands the record to `store.save` (latest-wins per uid, serialized by
  the durability fix).
- `flush(id): Promise<void>` resolves when the latest scheduled record for
  `id` is durable, and rejects if that write failed. It is used **only**
  outside the end-of-turn window: by the Part B permission-resolution path and
  by enqueue-while-suspended (A5).
- `drain(): Promise<void>` waits for every pending write, for shutdown.
- `remove(id)` handles `close` (Open question 5): it cancels any queued write
  for `id`, then deletes the file.
- A failed write → `onError(error)`, the daemon's existing sink
  (`serve.ts:24-25`, printed at `main.ts:227`). The session keeps serving from
  memory and the next `schedule` retries with fresher data. It is never thrown
  into the agent loop.

A3. **Where writes happen (the cut).** Each write sits at a point where the
history is a committed prefix (P1):
- **every committed boundary**: inside `HostedSession.onCommitted()` (assumed,
  event-stream). This covers round end, each tool result and compaction
  (`session.ts:97` also calls `onPersist`; wire `Session`'s existing
  `onPersist` hook to `schedule` as well, so a `compact` reached by any path
  writes);
- **turn start**: right after the turn driver marks the turn running, to
  record `turn.turnId` and the user prompt. The `turnIds` entry is written
  here, so the dedupe key is durable before the model is called;
- **suspension**: in the requester wrapper (`hosted-session.ts:48-52`),
  synchronously, *before* forwarding the request. The record gets
  `turn.pending = {toolCallId: currentToolCallId, tool, resumable, requestedAt}`;
- **enqueue**: after `Session.enqueue` pushes (A5);
- **turn end**: in the turn driver, **after** the synchronous segment that
  emits `turn_end` and clears the controller. The record has no `turn`. This
  is plain sequential code after the segment (`controller = null;
  persister.schedule(...)`). Because `schedule` returns `void`, nothing in
  the segment awaits. **Update the INVARIANT comment** at `agent.ts:270-278`,
  which names `HostedSession.prompt`, to name this write: "the daemon's turn-end
  write is `persister.schedule` (void, sync capture) after the controller is
  cleared — never `await persister.flush` here".

A4. **Classifying a pending request (pure, `persisted-session.ts`).**
`classifyPending(messages, currentToolCallId, currentToolName, request)` →
`resumable: boolean`. It is true iff all of these hold:
- `request.tool === currentToolName`;
- the last `assistant` message contains `currentToolCallId`;
- every call before it in that message is answered by a `tool` message after
  it, and it is not answered itself.

A sub-agent's request fails the first check (P7: the parent's current call is
`agent_task`, which never asks). This is the Open question 6 case.
`HostedSession` records the current tool's **name** together with the id it
already tracks (`hosted-session.ts:101-103`).

A5. **Steering is persisted, and an acked steer while suspended is durable.**
`Session` gets `pendingSteering(): readonly string[]` (a copy). Every record
built while a turn runs includes it. `HostedSession.enqueue` keeps the
synchronous `running` check and push, so the invariant is unchanged. It then
calls `schedule`. When the turn is **suspended**, the `enqueue` handler (made
async, *after* the synchronous push) awaits `persister.flush(id)` before
acking. An ack then means the steer is on disk. This await comes after the push
and is not inside the end-of-turn window, and peer dispatch stays concurrent
(AGENTS §7). When the turn is running but not suspended, the ack does not wait.
A crash then ends the turn anyway, and A6 keeps the persisted steers.

A6. **Reload on `serve` start (`SessionHost.restore`).** `startDaemon`
creates the persister over `JsonSessionStore(<configDir>/daemon/sessions)`
(P6), takes the lock (A7), then calls `list()`. For each valid record it calls
`reconcileOnReload(record)`, a pure function in `persisted-session.ts` that
returns `{messages, notes}`:
- no `turn` → the history is used as is;
- `turn` present (the daemon died mid-turn):
  - every unanswered call in the trailing assistant message is answered
    synthetically, right after the existing answers. Calls run in order (P2),
    so this needs only two texts:
    - **"Interrupted"** for the first unanswered call when there is **no**
      `pending`. It was in flight and may have run: `"Interrupted: the daemon
      restarted while this tool was running; it may or may not have completed.
      Check before retrying."`;
    - **"Not run"** for the pending call, and for every call after the first
      unanswered one. None of them started: `"Not run: the daemon restarted
      before this call ran (it was waiting for approval or queued behind
      one). Ask again if it is still needed."`.

    In **Part B**, a `resumable` pending turn is resumed instead (B3);
  - `turn.steering` entries are appended as `user` messages. This mirrors
    "kept in the history rather than dropped" at `agent.ts:411-419`.

  `restore` then builds the agent through the normal factory (`session-host.ts:39-41`).
  It registers the session **detached** with `lastActiveAt` from the record
  (TTL; a record already past the TTL and not suspended → close + `remove`),
  seeds the `turnIds`/`enqueueIds` dedupe maps, and schedules one write of the
  reconciled record. It does **not** emit stream events: no client is
  attached, and the boot epoch (Open question 2) forces any returning client to
  resync from the snapshot.

  An invalid, corrupt or unsupported record is skipped. `serve` prints one
  pre-listen line per skipped file (path + reason) and keeps the file. `serve`
  owns stdout/stderr (no Ink), so this is allowed.

A7. **One daemon per store.** Before reloading, `startDaemon` takes
`<store>/.lock` with `openSync(…, "wx")` and writes its pid. On `EEXIST` it
reads the pid. A live holder → `serve` refuses to start: "another tentacle
serve (pid N) owns <dir>; stop it or remove <dir>/.lock". A dead holder → the
lock is taken over (unlink + retake once). The lock is released on shutdown,
after `persister.drain()`. `SIGINT` handling (`main.ts:230-235`) becomes:
`server.stop()` → `await persister.drain()` → release the lock → resolve.

A8. **Pods unchanged, structurally.** Only `startDaemon` passes
`persistence`. `startStdioDaemon` (`serve.ts:67-91`) and the worker
(`worker.ts:80`) construct `SessionHost` without it, so `HostedSession` holds
`persister: null` and every `schedule` is skipped. To make that testable,
extract each host construction into an exported factory
(`createServeSessionHost(config, persistence)`,
`createStdioSessionHost(config, opts)`). Pod sessions keep laptop-side
persistence from `snapshot` (AGENTS §7).

A9. **AGENTS §7 amendment (rides this branch, §10(c)).** Replace the first
sentence of "Persistence lives on the laptop/main thread" with:

> **Persistence lives on the laptop/main thread — and, where the daemon is
> trusted (`serve` on the user's own host), the daemon also persists.** The
> client always persists its own copy from `snapshot` (offline viewing,
> `open{messages}` recovery); a `serve` daemon additionally writes each live
> session to `<configDir>/daemon/sessions/` at every committed boundary and
> reloads it on start, and on re-attach the daemon's copy wins. Pod daemons
> (`serve --stdio`, `run`/`attach`) never persist: a pod-written record is
> pod-supplied data (next bullet). The daemon's turn-end write is
> fire-and-forget (`schedule`, never awaited) — steering invariant.

The rest of the bullet (main owns the uid, persist only `ChatMessage`s) stays.
Add a cross-reference from the pod-trust bullet: "this is why pod daemons
store nothing durable".

**Part B — `suspended-turn-resume` [B] (after `permission-events`).**

B1. **Agent seam (minimal loop change).** Make two changes in `agent.ts`:
- Extract the per-call body at `:304-341` into
  `private async *runToolCalls(calls, messages, toolContext, signal)`. The
  behaviour stays identical, the abort/synthetic-answer branch included.
- Add an optional 5th parameter:
  `runMessages(messages, sessionId, signal?, drainSteering?, opts?: { resumeFrom?: string })`.

With `resumeFrom` set, before `flushBackgroundExits` and the first iteration,
the loop validates the trailing shape with the same pure check as A4. On a
mismatch it throws `ResumeShapeError`, and the caller falls back to A6's
reconciliation. On a match it runs `yield* this.runToolCalls(unanswered calls
from resumeFrom on)` and then enters the loop as usual. Calls *before*
`resumeFrom` are never re-run. Without `opts`, behaviour is byte-identical to
today, and `Session.send` never passes it. **Explicit opt-in on purpose:**
auto-resuming any dangling call would re-execute a call that was interrupted
mid-run (history-validity repro H: the side effect already happened).

B2. **`Session.resume(toolCallId, steering, signal)`** is a generator like
`send` (`session.ts:62-76`), with two differences: it **does not reset**
the steering queue (it seeds it from the record), and it pushes no user
message. It calls `runMessages(..., { resumeFrom: toolCallId })` and persists
in `finally` like `send`.

B3. **Rebuild on reload.** In `reconcileOnReload`, a `turn.pending` with
`resumable: true` returns `{messages, resume: {turnId, toolCallId, steering}}`
instead of answering the call. `restore` then starts the turn driver on
`Session.resume(...)` with the persisted `turnId`, so the client's
`prompt{turnId}` still ends with `turn_end{turnId}`. Like any turn, it emits
`turn_start{turnId}`. The gate re-asks for `toolCallId`: the requester (now
event-based, `permission-events`) emits `permission_request` with a **new
nonce** and suspends again, with no timeout. The turn is `running`, so the TTL
reaper skips it and `enqueue` is accepted.

B4. **The pending record is cleared durably before the tool runs.** In the
requester wrapper, once the human's answer arrives, the wrapper sets
`turn.pending = undefined` in memory, then `schedule`s and **awaits
`persister.flush(id)`**, and only then returns the answer to the gate. The
tool therefore never starts while the disk still says "pending". Without this,
a crash between "approved" and the write would re-ask the call after the
restart and, if approved again, **run it twice**. This await is inside
`authorize` (`permission-gate.ts:74`), mid-round, so it is far from the
end-of-turn window, and the steering invariant does not apply there. If the
flush fails, the error is logged and the tool still runs (the user approved
it). The residual risk is a re-prompt after a restart for a call that already
ran. That needs a second human approval, so it is never a silent second run
(Failure modes).

### Files

Dependency order (agent → daemon → cli → docs). A = Part A, B = Part B.

1. **A** `packages/agent/src/session.ts`: `pendingSteering()`. **B**: `resume()`.
2. **B** `packages/agent/src/agent.ts`: extract `runToolCalls`, the
   `opts.resumeFrom` parameter, `ResumeShapeError`. **A**: update the
   INVARIANT comment text at `:270-278` (A3).
3. **A** `packages/daemon/src/persisted-session.ts` (new, pure):
   `DaemonSessionRecord`, `parseDaemonRecord`, `classifyPending`,
   `reconcileOnReload`. **B**: the `resume` branch.
4. **A** `packages/daemon/src/session-persister.ts` (new): `schedule` /
   `flush` / `drain` / `remove`, plus the lock helpers (`acquireStoreLock` /
   `release`).
5. **A** `packages/daemon/src/hosted-session.ts`: optional persister, current
   tool name, write points (A3), pending capture in the requester wrapper,
   enqueue-while-suspended flush, `lastActiveAt`. **B**: clear-then-flush (B4),
   resumed turn driver.
6. **A** `packages/daemon/src/session-host.ts`: `persistence?` option,
   `restore(record)`, `remove` on close. Exported from `daemon/src/index.ts`.
7. **A** `packages/daemon/src/connection.ts`: `enqueue` becomes async after the
   synchronous push (A5), only when suspended + persisted.
8. **A** `packages/cli/src/serve.ts`: `createServeSessionHost` /
   `createStdioSessionHost`; `startDaemon` opens the store, takes the lock and
   reloads; it returns `{server, shutdown}`.
9. **A** `packages/cli/src/main.ts`: `serve` prints skipped records and the lock
   error pre-listen; on SIGINT it drains and releases the lock (`:221-236`).
10. **A** `AGENTS.md` §7: the amendment (A9).
11. Tests (below): `packages/agent/test/resume.test.ts` (B),
    `packages/daemon/test/persistence.test.ts` (A+B), an extension of
    `daemon/test/integration.test.ts` (steering invariant with a persister),
    and `packages/cli/test/serve-persistence.test.ts` (A).

No protocol schema change in Part A beyond the epoch inside the opaque `since`
(Open question 2), so no `PROTOCOL_VERSION` bump of its own.

### Failure modes

| Case | What happens / how state converges |
|---|---|
| Crash mid-write | Atomic rename (durability prerequisite): the old record or the new one, never half. At most the writes since the last committed boundary are lost. |
| Crash mid-turn, not suspended | `turn` is present without `pending`. Unanswered calls get the "Interrupted… may or may not have completed" result, never re-run. Steers become user messages. The session reloads idle, and a client re-attaching resyncs (epoch) and sees no running turn. |
| Crash while suspended (A) | The pending call gets "Not run…". The user sees it in the snapshot and can re-prompt. Nothing was denied or run. |
| Crash while suspended (B) | The turn is rebuilt and `permission_request` is re-emitted with a new nonce. Approving runs the tool exactly once. |
| Crash after approval, before the tool started (B) | B4: the disk already has no `pending` → treated as interrupted, not re-asked. A flush failure in that window → re-prompt (human-gated), logged. |
| Late answer to the pre-restart nonce | `permission-events`: `PermissionNotPending`. The new nonce is unrelated, so the old answer never binds to the rebuilt request. |
| `ResumeShapeError` (record and history disagree) | Fall back to the A reconciliation (answered as "Not run"). Logged with the session id, never a silent drop. |
| Disk full / EACCES | `onError` logs it, the session keeps serving from memory, and the next `schedule` retries. An enqueue-while-suspended whose flush fails is acked with an error (`PersistFailed`, an `RpcError` domain code) **after** the push, so the client knows the steer is queued but not durable. Never an unhandled rejection (durability repro (b)). |
| Two `serve`s on one store | A7 lock: the second refuses to start. A stale lock from a dead pid is taken over. A pid reused after a reboot gives a false "held": the message names the lock file to remove (documented limit). |
| Record from an unknown `schemaVersion` | Skipped, reported by path, never overwritten (a downgrade cannot destroy a newer daemon's data). |
| Corrupt or wrong-shape file | Skipped and reported (durability `list`). Other sessions still load. |
| Client returns with a pre-restart `since` | The epoch mismatches → resync (Open question 2). It never replays across the restart. |
| Client retries `prompt{turnId}` after a restart | `turnIds` is persisted → cached ack, never re-run (Open question 3). |
| `open{messages}` for a reloaded id | Registry rule: a live id is attached and never overwritten, so the daemon's copy wins (Review). |
| `close` racing a scheduled write | `remove` cancels the queued write before deleting, so the file is not resurrected. |
| Background jobs | Killed on daemon exit (`background-process-groups` exit net). They are not restored. A later `shell_output` on an old id returns the tool's normal unknown-job error. Documented limit. |
| Sub-agent suspension | Not resumable (Open question 6): the `agent_task` call is answered with an explicit interrupted note. |
| Pod daemon | No persister → no file is ever opened (A8). |
| Remembered grants after a restart | Lost → re-asked (Open question 4). Fails safe. |

### Tests

Red before green (§9): each test is shown failing on `main` (or with the
feature stubbed) first. Fakes: the repo's `ScriptedProvider` pattern
(`agent/test/permission.test.ts:23-33`), a fake env, real
`Agent`/`Session`/`PermissionGate`. **Fake store** `SpyStore`: an in-memory
`save` that resolves on demand (`release()`), exposing `durable` (the last
*completed* save per uid) and `saves[]`. There is no real disk except in the
cli test, which uses a temp `configDir`.

**Part A**
1. **Restart after `turn_end` → history intact.** Run a turn on a host with
   `SpyStore`, then build a *new* `SessionHost` over the same store and
   `restore` → `snapshot()` deep-equals the pre-restart history, and the
   session is detached and idle. Property: snapshot equality, not "a file
   exists".
2. **Restart mid-suspension (A semantics).** Suspend on `c2` of
   `[c1 none, c2 ask, c3 ask]`, enqueue `steer-1`, then restart → history =
   `…assistant[c1,c2,c3], tool(c1), tool(c2:"Not run…"), tool(c3:"Not run…"),
   user:"steer-1"`, and the exec spy is empty. Property: no "Interrupted" text
   when a pending record exists (nothing was in flight). Mutation: label every
   unanswered call "Interrupted" → fail.
3. **Crash mid-tool (no pending).** `durable` was captured while `c1` (of
   `[c1, c2]`) ran → on reload `c1` gets "Interrupted", `c2` gets "Not run",
   and neither is re-executed.
4. **Steering invariant with persistence.** Copy the macrotask test
   (`integration.test.ts:444-463`) with a `SpyStore` whose `save` never
   resolves until released → `runningAtNextMacrotask.at(-1) === false`.
   **Mutation:** make the turn driver `await persister.flush()` before
   clearing the controller → it must fail.
5. **Enqueue while suspended is durable at ack.** Suspend, send `enqueue`
   → the ack does not resolve before `SpyStore.release()`, and after it
   resolves `durable.turn.steering` contains the text. Mutation: drop the
   flush → the ack resolves while `durable` lacks it → fail.
6. **Idempotency across a restart.** `prompt{turnId:T}`, restart, re-send
   `prompt{turnId:T}` → cached ack, and the model spy is called 0 times.
   Mutation: do not persist `turnIds` → it runs twice.
7. **Pods write nothing.** `createStdioSessionHost` (and the worker host) over
   a temp `configDir`: run a turn, then `<configDir>/daemon` does not exist.
   Plus the type-level fact that `persistence` is absent.
8. **Lock.** A second `startDaemon` on the same `configDir` refuses with the
   pid in the message. A lock holding a dead pid is taken over.
9. **Bad records.** Truncated, wrong `kind` and `schemaVersion: 2` files are
   skipped, reported by path, and left on disk unchanged (byte compare); the
   valid ones still load.
10. **Store failure.** `SpyStore.save` rejects → `onError` is called, no
    `unhandledRejection` (spy on `process.on`), and the turn completes.
11. **P7 pinned.** `createTaskTool(...).permission === "none"`, and
    `classifyPending` returns `false` for a request whose tool differs from the
    current call (sub-agent shape).

**Part B**
12. **The load-bearing property** (agent level, `resume.test.ts`, the
    experiment's scenario). Uninterrupted run A versus suspend → JSON
    round-trip → `Session.resume`. Both of these must hold:
    - history deep-equal to A;
    - model calls after the resume = 1, and its first request ends with
      `tool(c2), tool(c3), user:steer-1`.

    Exec counts are each 1, and `c1` is not re-run. **Mutations:** implement
    `resume` as `send("")` → model-call count and history fail; drop the
    `answered` skip → `c1` runs twice → fail; reset steering in `resume` → the
    steer is missing → fail.
13. **Daemon restart mid-suspension (end to end).** Restart → the session
    reloads, `permission_request` is re-emitted with a nonce ≠ the old one, and
    approving runs the tool **exactly once** (exec spy). The old nonce →
    `PermissionNotPending`.
14. **Cleared before run (B4).** The tool's `execute` reads
    `SpyStore.durable` and records whether `turn.pending` is present → it must
    be absent. Mutation: `schedule` without `flush` → present → fail.
15. **Shape mismatch.** A record whose `pending.toolCallId` is not in the
    trailing assistant → `ResumeShapeError` → falls back to "Not run", logged,
    and nothing executes.
16. **Default path unchanged.** `runMessages` without `opts`: the existing
    `agent.test.ts` / `steering.test.ts` / `permission.test.ts` pass unchanged
    (the refactor guard for `runToolCalls`).

Gate per §4: the narrow files during iteration, then `bun run check`.

### Why, item by item

(Decisions not already argued in the Review.)

- **Why split A/B instead of one task.** Rebuilding a suspension needs a
  requester that works with no connection. Before `permission-events` the only
  requester turns "nobody connected" into a deny (`connection.ts:228-231`),
  which is the one outcome the owner forbade. A alone is still strictly better
  than today: history and acked steers survive, and a suspension is lost
  *visibly* ("Not run") instead of with the whole session. Each half is M, with
  its own red/green property.
- **Why capture the pending record in the requester wrapper, not in the
  agent.** It is the one place that already knows the call id
  (`hosted-session.ts:49`) and runs synchronously at the suspension. Putting it
  in the agent would add daemon concerns to a loop that every runtime shares.
- **Why `resumeFrom` is explicit and validated.** A dangling call has two
  possible meanings: "never authorized" (safe to ask again) and "was running"
  (unsafe to re-run). Only the pending record tells them apart, so the loop must
  never infer it from history alone.
- **Why calls after the pending one are re-run through the gate on resume.**
  They never started, and in an uninterrupted run they would be asked next
  anyway. The experiment shows the same prompts in the same order (B'' vs A).
- **Why `schedule` returns `void`.** The steering invariant has no robust
  test, because it depends on microtask order (`session-event-stream` Review).
  Making the dangerous form (`await persister.schedule`) a type/lint error is
  cheaper and stronger than a comment.
- **Why the build function runs synchronously inside `schedule`.** If the
  snapshot were taken when the I/O starts, later pushes would leak in, and the
  record would not match any cut. Synchronous capture makes each write equal
  the history at its call site.
- **Why flush (await) at exactly two points.** These are the two acks the user
  relies on: "I approved, so it runs once" (B4) and "I queued it, so it is not
  lost" (A5). Everywhere else, latency matters more than the ms-wide window, and
  a crash there loses only what a crash during the write would.
- **Why a separate store directory.** P6: the client uses the same uid in
  `<configDir>/sessions`. One directory would mean two writers racing on one
  file, with different record shapes.
- **Why reconcile honestly instead of dropping the dangling call.** The model
  must know a call was not run, or may have run. `history-validity-invariant`
  reaches the same conclusion (synthesize, don't drop). This reconciler is a
  narrow first instance of it. When that eval lands, its `repairHistory` must
  take the pending call id as an exception (the parent, point 8: "awaiting
  permission" is legitimate), and this function can delegate to it.
- **Why a boot epoch instead of persisting `seq`.** Every streamed chunk
  carries a seq, and persisting each one would mean a write per text delta.
  The epoch makes every pre-restart token invalid for free, and `resync` is
  already the designed path for "your token is useless".
- **Why grants are not persisted (yet).** Losing them only adds prompts.
  Persisting a lasting approval is exactly the kind of state the pod-trust rule
  scrutinises, and it deserves its own review even on `serve`.

## Execution

*— claude-opus-5-5, 2026-10-20*

Built in the order of the revision's Files list, on branch
`feat/daemon-side-persistence`. Baseline gate before any change: typecheck and
lint clean; `bun test` 1020 pass, 2 skip (the opt-in pair), 0 fail.

What was built:
1. `protocol/src/jsonrpc.ts`: `DaemonRestarted: -32012`. `schema/protocol.json`
   regenerated (one line).
2. `agent/src/session.ts`: `pendingSteering()`. `agent/src/session-store.ts`:
   `projectKey(cwd)` and `JsonSessionStore.remove(id)`. `remove` drops the
   queued record (its callers resolve), waits for the running write, then runs
   `rm -f`.
3. `daemon/src/persisted-session.ts` (new, pure): the record types,
   `toDaemonRecord`, `parseDaemonRecord` (kind, version, cwd, field shapes),
   `classifyPending`, `reconcileOnReload`, `restoredActivity`, and the three
   note texts plus `RESTART_TURN_END`.
4. `daemon/src/session-persister.ts` (new): `SessionPersister` (`schedule` is
   void and captures synchronously; `flush` never rejects; `remove`, `block`,
   `stop`) and `acquireStoreLock`.
5. `daemon/src/hosted-session.ts`: an optional 8th ctor parameter
   `persistence?: {persister, restored?}`, which seeds `turns`, `enqueued`,
   `createdAt` and `lastActiveAt`. The write sites are those in the table:
   ctor, `prompt` after `drive`, `history_commit`, the requester (set, then
   clear + `await persisted()`), `enqueue`, the `finishTurn` `finally`, and
   `historyReplaced`. `persisted()` is public. The current tool name is
   tracked.
6. `daemon/src/session-host.ts`: a `persister?` option; `restore(record)`;
   `close` → `persister.remove(id)`, which the reaper reaches through `close`.
7. `daemon/src/connection.ts`: `enqueue` is `async` and acks after
   `hosted.persisted()`. The running check and the push are still synchronous
   in `HostedSession.enqueue`.
8. `cli/src/serve.ts`: an `async startDaemon` that runs store dir → lock →
   `list` → block/notice the skipped records → `restore` → listen. It returns a
   `ServeHandle` whose `stop(): Promise<void>` is idempotent. Also
   `daemonStoreDir(config)`. `cli/src/main.ts`: `await startDaemon`, an
   `onNotice` printed as `[daemon] …` before the listening line, and a
   two-stage SIGINT.
9. `AGENTS.md` §7: the amendment, plus the pod-trust cross-reference.
   `agent.ts`: the INVARIANT comment names the daemon's turn-end write.

Drift from the Implementation, all small:
- **Existing tests touched:** `cli/test/serve-limits.test.ts` drives
  `startDaemon`. It now `await`s it and `stop()`. Because `serve` persists now,
  it also wipes `<configDir>/daemon` after each test; otherwise a test's
  sessions would be restored into the next one and change its session counts.
  This is behavioural evidence that the reload works.
- **A7 moved from the `HostedSession` level to a real `Connection` over a
  channel pair**, so the mutation "drop the await in `Connection.enqueue`" is
  caught. At the `HostedSession` level it would not have been.
- **A11 opens both kinds of skipped uid:** one that `list()` could not read,
  and one `parseDaemonRecord` refused. The first draft opened only the second,
  and the mutation "drop the `block` of a `list()`-skipped file" stayed green.
  Found by the mutation run, then fixed.
- **A13 expectation:** `session/open{sessionId}` without `since` answers
  `resync: true`. That is the designed answer (no token), so the test was
  corrected; the code was not changed.
- Tests live in `daemon/test/persistence.test.ts` (A1–A10, P4, P8, pure
  units), `agent/test/session-store.test.ts` (`remove`, `projectKey`),
  `agent/test/session.test.ts` (`pendingSteering`) and
  `cli/test/serve-persistence.test.ts` (A11–A13, real disk).

Red/green. Every new test was written after the code. Non-vacuity was shown by
**mutation** (§9): each mutation applied alone, the suite run, and the file
restored. Scripts: `.tentacle/tmp/daemon-side-persistence/mutate*.py`.

| Mutation | Turns red |
|---|---|
| turn-start `persist` before `drive` / dropped | A1 |
| no `finishTurn` write | A2, P4 |
| every unanswered call → INTERRUPTED | A3, A4 |
| a missing pending → NOT_RUN | A4, reconcile unit |
| `classifyPending` without the tool-name check | A5, classify unit |
| requester without `await persisted()` | A6 |
| `Connection.enqueue` without `await` | A7 |
| `HostedSession.enqueue` without `persist` | A3, A7, A8 |
| `drive` awaits `persisted()` before `finishTurn` | P4 |
| restored `turns` not seeded | A8 |
| no `persister.remove` on close | A9 |
| no `.catch` on the save | A10 |
| `blocked` ignored by `schedule` | blocked-id unit |
| `remove` doesn't wait for the running write / keeps the queued one | store `remove` |
| `projectKey` without `realpath` | `projectKey` |
| `pendingSteering` returns the live array | `pendingSteering` |
| no `restore` in `startDaemon` | A13 |
| no `block` (list-skipped / parse-skipped) | A11 (each) |
| no lock / no release | A12 / A11, A12, A13 |

Not mutation-checked, and why:
- **P8 (resync after a restart)** follows from the ctor minting the epoch
  (`hosted-session.ts:156-163`). There is no persisted epoch to "reuse", so no
  natural mutation exists.
- **"Pods write nothing"** is structural: only `startDaemon` creates a
  `SessionPersister`. The test only shows that a host without one stays
  silent.

Gate after the change: `bun run check` → typecheck clean, lint clean (289
files), `bun test` **1047 pass, 2 skip (the opt-in pair), 0 fail** across 109
files.

#### After the Review (REQUEST-CHANGES): findings addressed

*— claude-opus-5-5 (executor), 2026-10-20*

The owner asked for **one** review only, so these fixes were **not
re-reviewed** by a fresh context. Each one was shown red before green, then
mutation-checked (`.tentacle/tmp/daemon-side-persistence/mutate4.py`).

1. **(Medium) A detach did not write the TTL clock** (finding 1). Confirmed by
   reading the code: `removeAttachment` moved `lastActiveAt` and wrote nothing,
   so a restart saw an older clock than the live reaper did. Fix:
   `removeAttachment` calls `persist()`. Compaction now writes in `compact()`'s
   `finally`, after its clock moves. The `historyReplaced` write was dropped:
   the mutation run showed it is fully covered by the `finally` write, which
   follows it within the same `compact` call. New tests: **R1** (detach → the
   restored and live reapers agree) and **R2** (the compacted history plus the
   clock are on disk).
2. **(Low) Properties without a test** (finding 2). New tests:
   - **R3**: `restore` uses `restoredActivity`.
   - **R4**: nothing is written after `stop()`.
   - **A12** extended: a listen failure *after* the lock was taken releases
     it.
   - The compaction write is covered by R2.
3. **(Low) The project check compared raw strings** (finding 3).
   `parseDaemonRecord` now takes a `sameProject(cwd)` predicate, and
   `startDaemon` compares `projectKey`s. New test **R6**: the same project
   through a symlink restores its session.
4. **(Low) `JsonSessionStore.remove` could delete a newer save** (finding 4).
   A removal is now an operation in the uid's own latest-wins queue (the
   `REMOVE` marker), so the latest operation wins. A save made after the
   remove writes the file again. New store test: "a save AFTER a remove wins".
   The old "in flight + queued never resurrect" test still passes.
5. **(Nit) A blocked or unsafe id is now reported once** (findings 5, 6).
   `SessionPersister.schedule` writes one `onError` line per session that
   cannot be persisted: either its file was skipped, or its id is not a valid
   file name. New test **R5**. `remove` skips both kinds of id.
6. **(Nit) Stale-lock takeover race** (finding 7): documented as a limit in
   Failure modes, not fixed.
7. **(Nit) Doc drift** (finding 8): fixed the cited lines (`main.ts:239-242`,
   `worker.ts:87`) and the file count.

Mutations, each turning its test red: R1 drop the detach write; R2 drop the
compaction write; R3 restore from `record.lastActiveAt`; R4 ignore `stopped`;
R5 report on every write; R6 raw-string cwd compare; no `lock.release()` in
the startup catch; `remove` restored to its old implementation.

Gate after the fixes: `bun run check` → typecheck clean, lint clean (289
files), `bun test` **1054 pass, 2 skip (the opt-in pair), 0 fail** across 109
files.

## Review

*— claude-opus-5-5 (fresh-context subagent), 2026-10-20*

> The earlier eval-stage review text (2026-10-19, "Recommend promoting after
> `session-registry`…") is superseded by this review; it lives in git history.

**Verdict: REQUEST-CHANGES.** One medium finding (1). It is small to fix, but
it makes a restart delete sessions that the live daemon would keep, which is
what D-e promises cannot happen. Everything else holds or is low/nit. This
reviewer is **the same model as the executor** (claude-opus-5-5, only a fresh
context), so blind spots the two share may survive. A load-bearing task would
benefit from a different-model pass as well (AGENTS §10).

### Findings

1. **MEDIUM. Moving the TTL clock is never persisted, so a restart can reap
   (and delete) a session too early.** `HostedSession.removeAttachment`
   (`hosted-session.ts:329-334`) moves `lastActiveAt`/`lastDetachAt` to
   *now* on every detach, but it does not call `persist()`. The compaction's
   `finally` (`:663-664`) also sets `lastActiveAt` after the
   `historyReplaced` write. D-e's premise is "written while idle: its
   `lastActiveAt` is exact (nothing ended since)". That premise is **FALSE**:
   the reaper's own contract counts the end of an attachment as activity
   (`session-reaper.ts:28-33,40`). Repro
   `.tentacle/tmp/daemon-side-persistence-review/ttl.ts`:

   ```
   live liveness: {"attached":0,"busy":false,"lastActiveAt":5000,"lastDetachAt":5000}
   on-disk lastActiveAt: 1000
   live reap at t=6000, ttl=2000: []
   restored reap at t=6000, ttl=2000: [{"id":"s","reason":"idle_ttl"}] | file still on disk: false
   ```

   A real case: a TUI stays attached and idle for hours after its last turn,
   detaches, and the daemon restarts soon after. The idle TTL then runs from
   the last turn instead of the detach. The first sweep can close the session
   and `persister.remove` deletes its record. **Fix:** call `this.persist()`
   in `removeAttachment` and after the compaction's `finally` stamp. It is a
   synchronous capture; `removeAttachment` can run inside `emit` in
   `finishTurn`, and a capture is allowed there. Add a regression test:
   detach, restart, and the clock equals the detach time. Also pin that
   `restore` uses `restoredActivity` (mutation M10 below survives).
2. **LOW. Surviving mutations, i.e. test gaps on correct code.**
   - M8: no `lock.release()` on the startup-failure path (`serve.ts` catch).
     The behaviour is correct (e2e step 3: a TLS listen failure leaves no
     lock), but no test pins it.
   - M9: `schedule` ignores `stopped` (`session-persister.ts:64`). No test
     shows that writes stop at shutdown.
   - M10: `restore` uses `record.lastActiveAt` instead of `restoredActivity`
     (`session-host.ts:142`). Only the pure unit is pinned.
   - M12: the compaction write in `historyReplaced` is dropped. Nothing pins
     that a compacted history is the one on disk.

   Add one test each.
3. **LOW. The cwd check compares raw strings, while the store directory uses
   the realpath.** `parseDaemonRecord` checks `record.cwd !== cwd`
   (`persisted-session.ts:151`), but `projectKey` resolves symlinks
   (`session-store.ts` `projectKey`). The same project reached through a
   symlink spelling (`TENTACLE_CWD`/config `cwd`) shares the directory and
   the lock. Its own sessions are then skipped as "belongs to another
   project" and blocked. In e2e step 4 that is `same store dir: true`, then
   the notice `skipped …/s1.json: belongs to another project (…)`. No data is
   lost (the file is left as is), but the sessions are not restored and stay
   memory-only. **Fix:** compare realpaths (or `projectKey`s), or write the
   realpath as the record's `cwd`.
4. **LOW. `JsonSessionStore.remove` can delete a record that was saved after
   the remove started.** `remove` awaits `slot.running` (`session-store.ts:376`).
   That is the pump promise, and the pump also writes any record queued
   during the wait. The `rm` then deletes the newer record, although that
   save resolved as "durable", which breaks `save`'s contract. Repro
   `remove-race.ts`: save(1) → remove → save(2) → all resolve → `file exists:
   false`. Through the host this needs `session/close` and then
   `session/open{sameId}` within one in-flight write. The next write
   recreates the file, but an `enqueue` ack in that window could claim a
   durability that is undone. **Fix:** let `remove` wait only for the write
   in flight at call time and have the pump re-check (a removal generation),
   or have `SessionHost` defer re-creating an id until its removal settles.
5. **NIT. D-c promises a log line that does not exist.** D-c says that when
   a client later opens a blocked uid, "one log line says why". No such line
   exists: `schedule` returns silently for a blocked id
   (`session-persister.ts:64-66`). Only the startup notice reports the file.
   Add the line, or change the doc.
6. **NIT. A session id the store refuses is never persisted, and this is
   logged at every boundary.** The protocol allows any non-empty id
   (`protocol/src/session.ts:17`), while the store accepts only `SAFE_ID`.
   For such an id every `schedule` rejects inside `writeAtomic` with
   `invalid session id`, and `onError` logs it at each boundary. This is
   safe: no path traversal, since `remove` checks the id too. But it is
   noisy, and the session is silently memory-only. Report it once (or
   refuse such ids on `serve`).
7. **NIT. Two concurrent takeovers of a stale lock can both win.** The
   takeover is `rmSync` and then `take()` (`session-persister.ts:173-174`).
   Two daemons starting at once on a stale lock can both succeed, because B's
   `rm` removes A's fresh lock. This is a narrow TOCTOU and is not documented
   next to the pid-reuse limit. Take over with a rename, or re-read the pid
   after `take()`.
8. **NIT. Documentation drift.** Execution says lint covered "287 files";
   the gate now reports 289. The premise `main.ts:230-235` (SIGINT handler)
   is at `:239-242` on `e3c3293`. `worker.ts:86` is `:87`. The tests were
   written after the code: the red-first rule was not followed literally,
   and non-vacuity was shown by mutation instead. Execution says so honestly.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean; lint `Checked 289 files … No fixes
applied` (0 errors, 0 warnings); `bun test` **1047 pass, 2 skip, 0 fail**,
4135 `expect()` calls, 1049 tests across 109 files. The 2 skips are the
opt-in pair (AGENTS §6). This matches Execution's counts.

### Mutation outcomes (reviewer-chosen; script `.tentacle/tmp/daemon-side-persistence-review/mutate.py`, each applied alone, original bytes restored)

| # | Mutation | Result |
|---|---|---|
| M1 | requester never sets `pending` | RED: A3, A5, A6 |
| M2 | `finishTurn` keeps `pending` | green. Not reachable: `authorize` blocks the generator, so `finishTurn` cannot run while the requester is outstanding (except `close`, which sets `closed`). Defence in depth, acceptable |
| M3 | reconcile appends the steers before the synthetic tool answers | RED: A3, reconcile unit |
| M4 | no cwd check | RED: A11, parse unit |
| M5 | restored `enqueued` ids not seeded | RED: A8 |
| M6 | `persister.remove` before `hosted.close` | green. Equivalent: `hosted.close` sets `closed` before its `finishTurn` write, so the order does not matter |
| M7 | `Connection.enqueue` awaits before the push | RED: A7 |
| M8 | no lock release on a startup failure | **green (gap, finding 2)** |
| M9 | `schedule` ignores `stopped` | **green (gap, finding 2)** |
| M10 | `restore` ignores `restoredActivity` | **green (gap, finding 2)** |
| M11 | no `history_commit` write | RED: A4 |
| M12 | no compaction write | **green (gap, finding 2)** |
| M13 | no constructor write | RED: A13, A11 |
| M14 | only the first unanswered call answered | RED: A3, A4 |
| M15 | no turn-key `end` validation | RED: parse unit |
| M16 | restart end not applied | RED: A8, reconcile unit |

The tree was byte-identical afterwards: `git status --short`, `git diff
--stat` and the sha of `git diff` match the pre-review snapshot, and the 4
untracked files have the same shasums. The only edit is this section.

### Premise table (cited on `e3c3293` unless noted)

| Premise | Verdict |
|---|---|
| `finishTurn` is non-async, `hosted-session.ts:472-488`; `drive` calls it on `turn_end` before returning, `:420-423` | TRUE |
| `save` is sync to its promise, `session-store.ts:251-264`; first `await mkdir` at `:296` | TRUE (and `JSON.stringify` runs later, at write time; the capture is a shallow copy of immutable messages, so this is fine) |
| macrotask probe at `integration.test.ts:525-557` | TRUE |
| epoch per incarnation `:156-163`; `replayFrom` resync `:271-279` | TRUE (e2e: re-open → `resync: true`, new epoch) |
| `turns` `:119`, `enqueued` `:121`, retried prompt `:370-373` | TRUE |
| `configDir` global, `load.ts:157` | TRUE |
| `session-host.ts:179` ignores the record cwd (`createAgent(defaultCwd)`) | TRUE |
| requester routes to the latest attachment or denies, `:169-177` | TRUE |
| store serialized/latest-wins `:244-264`; `list` `:384-408`; strict message keys `:138,149-152` | TRUE |
| cut moves at `:426-429`, `:486`, `:553-569` | TRUE |
| `Session.onPersist` not wired on the daemon, `session-host.ts:181` | TRUE |
| the prompt is pushed within the first `next()`, `session.ts:62-70` | TRUE (A1 + e2e) |
| P1 push/commit lines `agent.ts` | TRUE |
| P3 `session.ts:32,65,83-85`; enqueue check `hosted-session.ts:496-509` | TRUE |
| P4 `agent.ts:287-296`, `hosted-session.ts:410-417` | TRUE |
| P5 only `startDaemon` gets a persister; stdio `serve.ts:109-183`; worker `:86` | TRUE (worker `new SessionHost` at `:87`; on the current tree `persister` appears only in `serve.ts` `startDaemon`/`reloadedHost`) |
| `main.ts:230-235` SIGINT handler installed | TRUE in substance; lines drift (`:239-242`) |
| P7 `agent_task` `permission: "none"` (`task.ts:52`) | TRUE |
| P9 `PermissionRequest.tool`, `core/src/permission.ts:16` | TRUE |
| `tool_start` precedes `authorize` (needed for `currentToolCallId`) | TRUE (`agent.ts` yields `tool_start` before `runTool`; sub-agent progress maps to `subagent_*` only, never `tool_start`) |
| **D-e: an idle record's `lastActiveAt` is exact** | **FALSE**: finding 1 |

### Attacks tried

1. **Steering no-await window.** `finishTurn`'s write goes through
   `persist` → `schedule` → `build` → `toDaemonRecord` → `store.save` →
   `pump` → `writeAtomic` up to `mkdir`. All of it is synchronous. P4 exists,
   and Execution's mutation (await before `finishTurn`) turns it red.
   `Connection.enqueue` keeps the check and the push in one synchronous step.
   The await only delays the ack (M7 → A7 red). **Holds.**
2. **"Pending on disk ⇒ never started".** Paths traced: deny; cancel; close
   during a request (`closed` → no write; the requester's `finally` sees
   `pending` already cleared); nobody attached (no `pending` set); request
   rejected (`Connection.requestPermission` → cancelled → `finally` clears
   and flushes); sub-agent (`currentToolName` = `agent_task` →
   `resumable: false` → sub-agent note); shutdown during a request. On
   shutdown, `server.stop(true)` closes the peers, and the deny arrives
   after `stopped`, so the disk keeps `pending` for a tool that was denied:
   "Not run" is true. On the approval-then-SIGINT race, the clearing
   `schedule` runs in the same microtask continuation as the outcome, before
   any SIGINT macrotask, and `stop` drains it. **Holds**, apart from the
   documented two-failure limit.
3. **Pods and the worker.** `startStdioDaemon` and `worker.ts` build
   `SessionHost` without `persister`, and the stdio branch in `main.ts:197`
   never reaches `startDaemon`. **Holds** (structural).
4. **Restore with the reaper/TTL.** Found **finding 1** (detach clock not
   persisted). Limits never refuse a restore (by design). A restored session
   keeps `createdAt`.
5. **Close/remove races and blocked files.** `closed` stops writes before
   `remove`. Blocked ids are never written or removed (A11 green). **Finding
   4**: a remove followed by a re-open of the same id.
6. **Locking.** Same project → refused with the pid (e2e step 3). A listen
   failure after the lock releases it (e2e step 3, `lock left behind:
   false`). The second SIGINT exits with the lock left, then a dead-pid
   takeover. Stale takeover race: **finding 7**.
7. **Hostile or malformed records.** The id must match the file name, and
   the messages and toolCalls are strictly validated. `parseDaemonRecord`
   covers `turns`/`end`/`turn`/`pending`. `restore` throws only on a
   duplicate id, which file-name uniqueness rules out. Reconcile cannot throw
   on a validated record. A `turn.turnId` missing from `turns` just gets no
   cached end. **Startup cannot be crashed by a record** (tried by reading
   the code; no file fuzzing). An odd but valid history can still make the
   provider error at the next turn, which matches the client store.
8. **Protocol.** `DaemonRestarted: -32012` collides with nothing.
   `TurnErrorSchema.code` is an open `int` (old clients parse it).
   `schema/protocol.json` is regenerated and the drift gate is green.
   **Holds.**
9. **Other history mutators.** The steering drain (in-memory move, covered
   by every capture), the continue-nudge, the max-iterations report, the
   turn error (all covered by the `finishTurn` write) and compaction (covered
   by `historyReplaced`, but untested: M12). Background jobs are not
   restorable after a restart; the history may name a job the new daemon
   does not know. Acceptable for Part A, but not written down.
10. **End-to-end trace** (`.tentacle/tmp/daemon-side-persistence-review/e2e.ts`;
    real `startDaemon` on a temp `TENTACLE_CONFIG_DIR`, a mock OpenAI SSE
    server, a raw WS client). A turn suspends on `fs_write` and
    `enqueue{e1,"steer-1"}` is acked. The disk then has
    `turn={turnId:T1, steering:[steer-1], pending:{c1, fs_write, resumable:true}}`.
    `stop()` releases the lock. On restart the notice is "restored 1
    session". Re-open gives `created:false, resync:true`. The snapshot is
    `system, user:write it, assistant[c1], tool(c1):Not run…, user:steer-1`.
    The marker file was **not** created. A retried `prompt{T1}` returns
    `ended.error.code -32012` with 0 model calls. A retried `enqueue{e1}`
    succeeds as a dedupe. A new turn T2 ends cleanly and the disk then holds
    `turns [[T1,error],[T2,end_turn]]` and no `turn`.

### What holds

The load-bearing assumption (no await in the steering window), the D-a
ordering, D-b acks, D-c blocking, D-d idempotency across a restart, D-f
shutdown and the two-stage SIGINT, D-g creation writes, reconciliation
order and labels, per-project directories, pods and the worker never
persisting, the additive protocol change, and the AGENTS §7 amendment, which
is accurate and cross-referenced in the pod-trust bullet. The new code is
cleanly split into a pure module (`persisted-session.ts`) and a thin I/O
shell (`session-persister.ts`), as AGENTS §7 asks.

### How the executor behaved

The work was disciplined. The executor followed the revised plan in order
and re-verified the premises on the current `main`. Every drift was
recorded honestly: A7 moved to a real `Connection`, A11 was found weak by
its own mutation run and fixed, A13 had its expectation corrected rather
than the code. The scope stayed on Part A. Two things fell short: the
red-before-green rule was replaced by after-the-fact mutation (stated
openly), and the mutation list missed the lock-on-failure, `stopped`, wiring
of `restoredActivity` and compaction properties. The one design-level miss,
finding 1, is a premise (D-e) that was stated without being checked against
the reaper's own contract.
