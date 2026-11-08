# feat/session-log-serve-store — the `serve` daemon store becomes the typed event log (`<uid>.jsonl` + a small state sidecar)

> **Status:** Executed (2026-11-08) — awaiting the mandatory fresh-context Review and the live `serve`/`connect` run
> **Branch:** `feat/session-log-serve-store` (to open off `main` @ `bd46999`, which has task 2 merged)
> **Type:** feat · **Size:** L · **Blast:** load-bearing (§7 daemon-side persistence: steering window, "pending on disk ⇒ never started", archive, suspended-turn resume, on-disk versioning; the shared log store task 2 landed) · **Suited:** strong model executes; mandatory fresh-context Review (`docs/REVIEWER-BRIEF.md`) red-teaming the crash contract across two files, the steering window and the archive paths
>
> Task 3 of 3 (`docs/eval/session-persistence-format.md` "## Owner decisions (2026-11-07)"): `feat/session-log` (done) → `feat/session-log-laptop-store` (done, merged `3031822`) → **this**.

**Where citations point.** Task 2 was merged while this plan was written (`3031822`, `bd46999`).
So every `file:line` below is on **`main` @ `bd46999`**, and that includes task 2's
`packages/daemon/src/session-log-file.ts` and `session-log-store.ts`. I checked the line
numbers against the merged tree; they are identical to the task-2 branch I first read.

## Context

*— claude-opus-5-5, 2026-11-08*

**Problem.** The laptop now keeps one typed log per session (`<uid>.jsonl`, task 2). The `serve`
daemon still keeps the old whole-record JSON:
- `serve.ts:122` builds `new JsonSessionStore(dir)`. Every `HostedSession.persist()`
  (`hosted-session.ts:808-812`) captures the WHOLE history (`messages: [...this.session.messages]`,
  `:895`) and rewrites the whole `<uid>.json`.
- That happens at ≥ 2 sites per round (every `history_commit`: `:1600-1601`, turn end `:1721`;
  eval `session-persistence-format.md:59` counts 15 call sites).
- Result: two formats on disk, and the daemon's on-disk version is still `DAEMON_RECORD_VERSION = 8`
  (`persisted-session.ts:53`), with a v1–v8 read ladder (`:55-61`, `:204-355`).

Linux cost (orchestrator, Docker Desktop VM, overlayfs: `.tentacle/tmp/session-log-laptop-store/linux-measurements.md`):

| Write | p50 | p99 |
|---|---|---|
| today: whole 2 MB rewrite (temp + fsync + rename) | 1.88 ms | 5.74 ms |
| today: whole 4 MB rewrite | 4.82 ms | 9.13 ms |
| a 2.7 KB append + fsync | 0.36 ms | 1.76 ms |

Four concurrent `O_APPEND` writers produced 0 torn or interleaved lines, with lines up to 70 KB.
Today's rewrite also stringifies the whole record on the event loop for every persist.

**Owner decisions this task implements (binding):**
- One format everywhere: the daemon store uses task 2's `<uid>.jsonl` (header + `session/log`
  entries, `session-log-file.ts`).
- No back-compat and no legacy conversion. Old daemon `<uid>.json` records are ignored (the owner
  deletes the folders).
- Never add or change a `critical` value. **This plan adds no entry type and changes no value.**
  `LOG_ENTRY_CRITICAL` stays as it is. The reload uses the existing `base{reason:"reload"}` with
  the existing optional `prev`.
- The suspended-turn state stays a small whole-file sidecar (eval Q10 round 2,
  `session-persistence-format.md:1273-1275`).
- `serve` lineage across reloads (task 1 Q12, `docs/feat/session-log.md:563-565`) is IN this task.
- `DAEMON_RECORD_VERSION` is replaced by the log header version (plus the sidecar's own version:
  Q3).

**Constraints.**
- No wire change. No schema change and no `PROTOCOL_VERSION` bump. `serve` is trusted (its host is
  the user's, §7), so the daemon writes its OWN derived entries. There is no client in between, so
  F4 re-serialization does not apply.
- Pod daemons and the worker still never persist. Only `startDaemon` builds a persister
  (`serve.ts:129-136`): unchanged.
- `connect` still keeps no laptop copy: unchanged.

## Implementation

*— claude-opus-5-5, 2026-11-08*

### Load-bearing assumption

> **The `serve` persister keeps today's crash contract with two files instead of one.** After any
> crash, a reload sees exactly ONE capture that has landed, history and state together. "Pending
> on disk ⇒ never started" still holds. The capture stays synchronous, with no more work in the
> steering window than today. This holds because:
> (i) every capture can be written as *the session log through its tip* plus a small overlay;
> (ii) every wait on durability waits for the whole unit, which is the log first and then the
> sidecar;
> (iii) the sidecar names the log entry it was captured at, and the loader reads the log only
> up to that entry.

**Status: PROVEN — statically (file:line below) and empirically for (i) (probe, 984 captures).**
It is pinned first in Execution by test S1, before anything else is wired.

**Proof.**

1. **(i) A capture = the log through its tip + an overlay (k, tail).**
   - The log's projection after each derivation is `SessionLog.ref`. It is `messages.slice(0,
     length)` at `commit` (`session-log.ts:100-119`) and `messages.slice()` at a new segment
     (`:233-251`), so it is never mutated in place.
   - Task 1's D1 assertion pins that the replay of the entries equals `ref` after every derivation
     (`hosted-session.ts:1188-1200`, `verifyLog`).
   - Define `k` as the longest common prefix, by reference, of `ref` and the captured
     `session.messages`, and `tail = messages.slice(k)`. Then `ref[0:k] ++ tail` equals the
     capture by construction. Messages are immutable values: task 1's load-bearing assumption,
     `session-log.ts:7-10`.
   - The non-trivial, measured fact is how large `tail` is and whether `k < ref.length` ever
     happens. Probe (Appendix A): over 38 test files (all of `packages/daemon/test` plus 5 cli
     serve test files), **984 captures**. The log's projection was a reference-prefix of the captured history in
     **984/984**. The overlay was 0 messages in 883 captures, 1 in 100, 2 in 1.
   - Where the overlay is non-empty:
     - a turn just accepted: `hosted-session.ts:1310` persists after the generator pushed the
       prompt, and the prompt "joins the log at the turn's first commit" (`:1286`);
     - a send-now start: `:1490`;
     - a first-round `beforeRun`: `:851`.
   - One case the probe did not hit, but which is statically possible, is `k < ref.length`. The
     agent annotates an already-committed message IN PLACE before a model request
     (`agent.ts:1156`, `noteContextUsage`). A `session/enqueue` during that request persists
     (`hosted-session.ts:1959`) before the next commit. The overlay covers this by definition
     (`k` = the index of the annotated message). Test S2 constructs it.
   - So if the sidecar dropped the overlay, a crash right after a prompt was accepted would lose
     that prompt. Today's record keeps it (Q2).
2. **(i) cont. — the capture costs no more in the window than today.**
   - Today's capture already copies the history (O(n) pointers, `:895`). The new capture adds an
     O(n) reference compare (exactly what `commit` already does inside the window,
     `session-log.ts:96-99`) plus O(Δ) references to the entries derived since the last capture.
   - No `JSON.stringify` and no hashing. A checkpoint's digest is lazy over an immutable `ref`
     snapshot (`session-log.ts:143-149`, `:203-231`), so materializing it later, after the
     persister's first `await`, gives the same bytes.
   - `SessionLog.read` (`:162-197`) DOES materialize and size entries. So the capture must use a
     new non-materializing `since()` (Design §2). It must not call `read`.
3. **(ii) Every durability wait goes through the persister's per-id promise.** The complete list:
   - `awaitDecision` shows the ask after `persisted()` (`hosted-session.ts:681`), and runs the
     tool after `await untilAborted(this.persisted(), signal)` (`:705`);
   - `beforeRun` waits for `persister.write(...)` landed (`:851-853`);
   - `beforeResumedCall` (`:873`);
   - the `session/enqueue` ack (`connection.ts:331`) and the `session/reclaim` ack (`:348`);
   - archive writes (`session-host.ts:695-701`, `:641`, `:858`).
   - `persisted()` is `persister.flush(id)` (`hosted-session.ts:819-821`) = the latest write's
     landed promise (`session-persister.ts:161-165`, `:231-233`).
   - The store runs one session's operations in FIFO order (`session-log-store.ts:334-361`). So if
     one operation = log op then sidecar op, and its promise resolves only after the sidecar, then
     every gated action (show an ask, run a tool, ack a steer) happens only after BOTH files of
     its capture are durable.
4. **(iii) The loader pairs the files at the landed capture.** A unit writes the log first, then
   the sidecar (temp + fsync + rename), and the sidecar carries `logHead` = the tip it was
   captured at. The cases:
   - *Crash between the two:* the log is AHEAD of the sidecar (its entries after `logHead` belong
     to a capture that never landed). The loader folds the log only THROUGH `logHead`. The result
     is the previous landed unit, exactly as a crash mid-rewrite of today's record leaves the
     previous record.
   - *Crash mid-append:* a torn last line is already ignored by `parseLogFile`
     (`session-log-file.ts:183-185`), and `logHead` is never that line.
   - *The sidecar's head is not in the log* (a crash after a REPLACE's rename, before its
     sidecar): the pair cannot be proven. The safe fallback is FM 4: load, close any cut turn
     honestly, never re-ask. Today a crash mid-turn already closes the turn.
   - Can a sidecar that lags by one unit pair a stale "pending" with newer history? No. The call
     cannot have started before the unit that cleared its pending landed (3.), and that unit's
     log part comes BEFORE its sidecar. So a stale pending names a call that never started.

### Preconditions (verified on `main` @ `bd46999`)

- **P1** A capture is synchronous and handed over at once: `schedule` → `write` → `toRecord(build())`
  (`session-persister.ts:88-109`). The I/O is the store's (`:139-166`).
- **P2** The state outside the history, as `DaemonSessionState` has it today:
  - fields: `id, createdAt, lastActiveAt, lastChangeAt, messages, turns, enqueueIds, turn?{turnId,
    steering, steeringIds, pending?, inFlight?}, archivedAt?, title?, returned?, head?`
    (`persisted-session.ts:101-119`);
  - it is captured in `persistedState` (`hosted-session.ts:877-915`);
  - `updatedAt` is `lastChangeAt`, never the write time (`session-persister.ts:220-228`), so a
    serve file's `mtime` can NOT be its `updatedAt`. That differs from the laptop (task 2 Q4).
- **P3** The reload repairs the history by APPENDING only. `labelUnansweredCalls` pushes
  (`persisted-session.ts:497-513`). Pushing the older steers (`:703-705`) applies only to a record
  without `steeringIds`, which can no longer exist once the ladder is gone. A resumed turn leaves
  the history untouched (`:650-653`). So the landed projection is a prefix of the repaired one,
  except for the in-place overlay of proof 1.
- **P4** `HostedSession` starts its log from the constructor (`hosted-session.ts:513-524`):
  - `start(messages, restored ? "reload" : reason, restored ? undefined : logOptions.base,
    resume?.turnId)`;
  - so today a reload has NO `prev` (new lineage). `SessionLog.start(…, from)` already supports
    continuing a lineage (`session-log.ts:79-92`: `seq = from.seq + 1`, `prev = from.id`, `root`).
- **P5** The client's lineage rule (`client/src/session-log-reader.ts:209-228`):
  - a rebased read whose `base.prev === held.head.id` is a `reseed` ONLY if the base's seed digests
    equal the held copy (`:213-218`); otherwise it is a `fork` (aside);
  - so a reload base must restate EXACTLY the projection a reader held at `logHead`, not the
    repaired history (Design §5).
- **P6** The archive path:
  - `SessionHost.archive` → `persister.archive(hosted.archive(), now)` (`session-host.ts:684-703`);
  - `HostedSession.archive` takes the history and the turn BEFORE `close`, and the keys and stamps
    AFTER it (`hosted-session.ts:2125-2145`);
  - `close` sets `closed` first (`:2090`), so its `finishTurn` → `persist()` writes nothing
    (`:808-812`);
  - idle TTL (`reapExpired`, `session-host.ts:828-847`) and the detached cap (`admit`, `:771-802`)
    both go through `archive`;
  - archived rename and reclaim rewrite the record without reopening it (`:609-643`); a failed
    archive write is retried by the sweeps (`:849-861`).
- **P7** The start-up scan (`serve.ts:204-262`):
  - tombstones first (`:211-227`), one record at a time (`:230`);
  - a file it cannot use is `block`ed and left as is (`:239-250`; `session-persister.ts:79-85`);
  - an archived record is indexed by metadata only (`:252-255`, `session-host.ts:666-675`), and a
    live one is restored (`:258`).
- **P8** Task 2's store, now on main, is the format's shared truth:
  - `LogSessionStore` (`session-log-store.ts:238`) has a per-uid FIFO queue (`:334-361`) and a
    per-session lock `.<uid>.lock` (`:202`, `:379-386`);
  - `writeLocked`: append if the write continues the file's last entry, else the same-segment
    suffix append, the skip when the file is ahead, or REPLACE (`:421-483`, `:506-580`);
  - the containment-or-aside rule (`settleLast`, `:587-629`), the temp/lock sweep (`:801-832`),
    the strict `parseLogFile` (`session-log-file.ts:178`) and `headerLine` (`:404-414`);
  - `LogWrite` = `{id, meta, entries, messages, read{from?, head, outcome}}` (`:65-77`);
  - an empty history writes no file (`:430-432`): wrong for serve (FM 26);
  - `TEMP_NAME` only knows `.jsonl` temps (`:200`).
- **P9** The store lock is `<dir>/.lock` (`session-persister.ts:300-348`). It does not match the
  per-session `LOCK_NAME` `^\..+\.lock$` (`.lock` has nothing between the two dots), so the sweep
  never removes it. Tombstones live in `deleted-sessions` (`session-tombstones.ts:18`), and `ids()`
  takes only `*.jsonl` (`session-log-store.ts:920-930`). Neither collides.
- **P10** After this task nothing in `src` uses `JsonSessionStore`, `parseSessionRecord`,
  `SessionStoreIo`, `DAEMON_RECORD_KIND/VERSION` or `parseDaemonRecord`/`toDaemonRecord` besides
  `serve.ts` and the persister (grep, `packages/*/src`).
- **P11** `sessions.keepSuperseded` exists in the file config since task 2. It is laptop-only today
  (never carried to a pod). `startDaemon` gets the full `TentacleConfig` (`serve.ts:114-117`).

### Design

#### 1. On disk (`<configDir>/daemon/<projectKey(cwd)>/`)

```
<uid>.jsonl          ← task 2's format, byte-compatible: header line + session/log entries
<uid>.state.json     ← the sidecar (whole file, temp + fsync + rename), the unit's COMMIT marker
.<uid>.lock          ← task 2's per-session lock (kept: one code path, Q13)
<uid>.stale-<ms>-<hex>.aside   ← task 2's asides
.lock, deleted-sessions        ← unchanged
```

Sidecar (compact JSON, one object):

```
{"format":"tentacle-daemon-state","schemaVersion":1,"id":"<uid>",
 "logHead":{"seq":57,"id":"<inc>/57"}, "k":41, "tail":[ChatMessage…],
 "lastActiveAt":…, "updatedAt":<lastChangeAt>, "title":<encodeTitle form>,
 "turns":[…], "enqueueIds":[…], "returned":[…], "turn"?:{…}, "archivedAt"?:…, "head"?:…}
```

- **Fields.** Every `DaemonSessionState` field except `messages` (P2), validated as the current
  `parseDaemonRecord` branch does today (`persisted-session.ts:279-354`, minus the ladder), plus
  `logHead` / `k` / `tail`.
- **Title.** `title` keeps today's record form (`encodeTitle`, `persisted-session.ts:156`), so the
  archive index needs no history. The log keeps its `title` entries for log readers. For the
  daemon, the sidecar's title is authoritative (Q8).
- **Versions.** The log keeps task 2's header (`format`, `schemaVersion`; constants renamed
  `SESSION_LOG_*`, Q12). The sidecar has its own `DAEMON_STATE_VERSION = 1` (Q3).
  `DAEMON_RECORD_KIND/VERSION` and the v1–v8 ladder are deleted (Q10).

#### 2. Capture (synchronous, in `HostedSession`; nothing else in the window)

- `SessionLog.since(after?: LogCursor) → {entries: Slot refs, head: LogCursor, rebased: boolean}`
  (new, pure). It returns references to the retained slots after `after`, or from the last `base`
  when `after` is absent, evicted or of another incarnation. It NEVER materializes a checkpoint or
  computes a size. `SessionLog` also exposes `projection` (= `ref`, read-only) and
  `materialize(slot, sha256)`.
- `persistedState()` gains `log: {delta, logged: this.log.projection, head}`. `delta` comes from
  `since(this.persistCursor)`, and `persistCursor` then advances to `head`. The cursor belongs to
  the `HostedSession`: a new incarnation starts cold. `messages` stays today's copy.
- `archive()` uses the `before` capture's log part (the history it already keeps, P6). The `after`
  capture is taken with no log part. So an archived file is "the shape a crash leaves", the same
  as today.

#### 3. Persister (`session-persister.ts`)

- **The store seam.** `RecordStore` becomes `DaemonStore`:
  - `write(unit)`: log op + sidecar, one FIFO op;
  - `writeState(id, sidecar)`: sidecar-only, for archived rename/reclaim;
  - `remove`, `drain`;
  - `load(id)`: log + sidecar → `DaemonSessionRecord`;
  - `loadState(id)`: header + sidecar only;
  - `scan()`.
- **The real store** is task 2's `LogSessionStore`, extended (§4). Tests keep an in-memory spy with
  the same seam (Tests).
- **`write`/`schedule`.** The capture is synchronous (P1). The async part starts after one
  `await`. It materializes `delta`, computes `k` (reference compare of `logged` against
  `messages`) and `tail`, encodes the sidecar, then calls `store.write({ id, meta, entries,
  messages: logged, read: { from: prevCursor, head, outcome: rebased ? "rebased" : prevCursor ?
  "linear" : "cold" }, sidecar, keepEmpty: true })`.
- **When it lands.** The unit's promise resolves when the sidecar is durable. That is the promise
  `flush`/`write`/`archive` return (proof 3).
- **`archive(state, at)`** = `write` with `archivedAt`.
- **`writeRecord(record)`.** For an archived rewrite or retry: if the record's log part is already
  on disk (`landedLog`), it is `writeState`. Otherwise it is a healing `write` with `entries: []`,
  which uses task 2's "append what the file lacks / replace from the segment" path
  (`session-log-store.ts:470-482`).
- **`load(id)`** (§6) → the in-memory `DaemonSessionRecord`. Its new shape: no `kind` /
  `schemaVersion`, plus `logged`, `logHead`, `paired`.

#### 4. Store (`session-log-store.ts`, shared with the laptop; additive)

- **`LogWrite.sidecar?: {path-free data}`.** After the log op succeeds, still inside the same
  queued op and lock, the sidecar is written atomically to `<uid>.state.json`. This includes the
  "continues, nothing new" path (`:445-447`) and the skip paths. A failed log op throws BEFORE the
  sidecar, so the old sidecar stays and the unit is reported as failed. The laptop never passes it.
- **`LogWrite.keepEmpty?: true`.** An empty history still writes header + `base` (FM 26).
- **Op `state`** (sidecar only). **`remove`** deletes the sidecar first, then the log and the
  asides (FM 25). **The sweep** also knows `.<uid>.state.json.tmp-<pid>-<hex>`.
- **`readRaw(id) → {parsed: ParsedLogFile} | absent | unreadable`** and **`readSidecar(id)`**: the
  daemon's loader, with no `closeAtLoad` (§6, Q4).
- **Containment rule** (`settleLast`, `:614`). A `base` whose `prev` equals the id of the file's
  last known entry restates that segment, so it is contained and gets no aside (Q11). This is the
  daemon's reload base after a clean pairing (§5). With unlanded entries after `logHead`, the
  file's last id ≠ `prev`, so the rule does not apply and the not-contained content goes aside as
  today. On the laptop the rule is redundant: a reseed there has already passed the client's
  seed-digest check (P5).

#### 5. Reload and lineage (Q12 of task 1; Q15)

- **`restore(record)`** (`session-host.ts:737-760`) passes `log: {head: record.logHead, logged:
  record.logged}` to `build`. The `HostedSession` constructor (`hosted-session.ts:518-523`) then:
  - calls `log.start(logged, "reload", head, resume?.turnId)` — the base restates exactly the
    LANDED projection, `prev = logHead`, `seq = logHead.seq + 1` (P4);
  - then `log.commit(session.messages, session.messages.length)`: the overlay and the repair notes
    become ordinary `replace` / `message` entries (P3).
  - `verifyLog` (D1) still holds (fold = `ref` = the cut).
- **What a reader sees.** A reader holding `logHead` reads `reseed` (P5) and then the repair as
  entries. A reader ahead of `logHead` (it read entries that never landed) gets the content compare,
  and a `fork` sets its copy aside: correct, since the daemon lost that content.
- **When the pair is not proven** (FM 4): no `prev` (a new lineage, today's behaviour).
- **The first write after a reload** is a cold capture (from the base), so a REPLACE. Its
  containment uses §4's rule: no aside when paired and nothing is unlanded; an aside of the
  unlanded entries otherwise.

#### 6. Load (`daemon-state-file.ts`, new, pure) and the start-up scan

- **`rebuild(parsed, state) → DaemonSessionRecord`.**
  - `logged` = the fold of the segment holding `logHead`, through `logHead` (new
    `foldThrough(parsed, id)` in `session-log-file.ts`, the shared `projectEntry` fold);
  - `messages = logged[0:k] ++ tail`, then the field checks of today's current branch;
  - `head` is checked as a user index of `messages` (`persisted-session.ts:327-333`), and
    `legacyHead` stays when none is marked (its "no unasked turn" reading is a rule of its own,
    `:324-326`);
  - `logHead` absent from the log → `paired: false`, `logged` = the last segment's fold, and
    `messages` = `logged` (the overlay cannot be applied). `resumableTurn` (`:595-620`) returns
    `undefined` when `!paired`, so the turn is closed honestly (Q5).
- **The cut-turn close stays `reconcileOnReload`** (`:642-707`), driven by the sidecar's exact
  `pending` / `inFlight`, NOT the laptop's `closeAtLoad`. That is a drift from the task-2 sketch,
  and the reason is that the sidecar is exact (Q4). The log's `turn_end` of an archived turn is
  never written (§2: `before` capture), so the two never disagree on disk.
- **`serve.ts` scan.** Tombstones first, as today. Then for each `*.jsonl`:
  - *(fix round 1, M2: the log's header is parsed FIRST; a missing, corrupt or newer-version header
    is `block` + "skipped … (left as is)", files untouched, whatever else is missing.)*
    Readable header of this version, sidecar absent → the log goes aside, reported, id free
    (FM 5, Q6);
  - sidecar unreadable, unknown `DAEMON_STATE_VERSION`, wrong project, log unreadable or an
    unknown log `schemaVersion` → `block` + "skipped … (left as is)" (today's rule, P7);
  - archived → indexed from header + sidecar ONLY (`addArchived(meta)`; the log is not parsed);
  - live → `load` + `restore`.
  - A legacy `<uid>.json` is ignored silently (not `*.jsonl`).
  - An orphan `<uid>.state.json` with no log is removed (a remove cut short; FM 25).

#### 7. AGENTS §7 wording (rule change, on this branch; Q14)

In the persistence bullet, replace "A `serve` daemon additionally writes each live session to
`<configDir>/daemon/<projectKey(cwd)>/` at every committed boundary and reloads it on start (one
daemon per store: a lock); on re-attach the daemon's copy wins." with:

> A `serve` daemon additionally writes each live session to
> `<configDir>/daemon/<projectKey(cwd)>/` in the same log format (`<uid>.jsonl`, its OWN entries:
> the daemon is trusted) plus a small whole-file state sidecar `<uid>.state.json` (turn, pending
> asks, keys, title, archive stamp, and the log entry it pairs with), written AFTER the log; a
> write lands when its sidecar does, and a reload reads the log only up to the entry the sidecar
> names (a crash during a rewrite, which leaves no such entry, loads the log's last segment
> instead and starts a new lineage). It reloads them on start (one daemon per store: a lock),
> continuing each session's log lineage; on re-attach the daemon's copy wins.

*(Reworded in fix round 1, owner answer 2 to the review: the parenthesis is new.)* and
"(record stamped `archivedAt`, indexed by metadata only, …)" → "(its sidecar stamped
`archivedAt`, indexed from the sidecar and the log's first line only, …)", and "the `serve` daemon's record is the truth"
→ "the `serve` daemon's log is the truth".

In "On-disk records are versioned separately", replace "A daemon record carries `schemaVersion`
(`DAEMON_RECORD_VERSION`), and an unknown one is refused and left untouched." with:

> A `serve` session's log carries the same header `schemaVersion` as the laptop's, and its
> sidecar its own (`DAEMON_STATE_VERSION`); an unknown one of either is refused and the files are
> left untouched (never written by that daemon).

### Files (dependency order; smallest diff)

1. `packages/protocol` — **none** (no schema, no `PROTOCOL_VERSION`, no `LOG_ENTRY_CRITICAL`
   change). Executor: confirm with a grep over the diff.
2. `packages/daemon/src/session-log.ts`: `since()`, `projection`, `materialize` (no change to
   `read`).
3. `packages/daemon/src/session-log-file.ts`: `SESSION_LOG_*` rename (Q12), `foldThrough`.
4. `packages/daemon/src/session-log-store.ts`: `sidecar` / `keepEmpty` on `LogWrite`, op `state`,
   `readRaw` / `readSidecar`, `remove` + sweep for the sidecar, the `prev` containment rule.
5. `packages/daemon/src/daemon-state-file.ts` (new, pure): sidecar encode/parse/validate, `rebuild`.
6. `packages/daemon/src/persisted-session.ts`:
   - `DaemonSessionState.log`;
   - `DaemonSessionRecord`: no `kind` / `schemaVersion`; `logged`, `logHead`, `paired`;
   - delete `DAEMON_RECORD_*`, `READABLE_VERSIONS`, `currentTurn`, `withoutIds`, the old-steers
     branch (`:703-705`), `toDaemonRecord`, and `parseDaemonRecord` → moved into
     `daemon-state-file.ts`;
   - `resumableTurn` honours `paired`.
7. `packages/daemon/src/session-persister.ts`: the `DaemonStore` seam, capture → unit, the
   `archive` / `writeRecord` / `load` / `loadState` rewiring. `acquireStoreLock` is unchanged.
8. `packages/daemon/src/hosted-session.ts`: `persistedState` log part and `persistCursor`;
   `archive()` with the `before` log part; the constructor's reload `start` + `commit` (+
   `restored.log`).
9. `packages/daemon/src/session-host.ts`: `restore` passes `log`; `addArchived(meta)`;
   `rewriteArchived` through `loadState` / `writeState`.
10. `packages/daemon/src/index.ts`: exports.
11. `packages/agent/src/session-store.ts`: delete `JsonSessionStore`, `SessionStoreIo`,
    `parseSessionRecord` (Q10). Keep `SessionRecord`, `LoadResult`, the title helpers,
    `projectKey`, `isValidSessionId`.
12. `packages/cli/src/serve.ts`: `new LogSessionStore(dir, {keepSuperseded:
    config.sessions?.keepSuperseded})` behind the persister; the scan of §6; notices naming
    `.jsonl` / `.state.json`.
13. Tests (below). Docs on this branch: this doc, AGENTS §7 (§7 above), `CHANGELOG.md`
    `[Unreleased]`, the `TODO.md` row, a pointer line in `docs/feat/daemon-side-persistence.md`
    ("store format: `docs/feat/session-log-serve-store.md`").

### Failure modes (each: how state converges)

| # | Case | Convergence |
|---|---|---|
| 1 | **Crash mid-append** (torn last line) | Ignored by `parseLogFile`. The sidecar names an earlier, complete entry, so the previous landed unit loads. The first write after the reload replaces the file. A torn line is never in a segment. |
| 2 | **Crash between log and sidecar** (log ahead) | The loader folds through `logHead` (proof 4), so the previous landed unit loads. Nothing gated on the lost unit ran (proof 3). The unlanded entries go aside at the first write (§4 rule: last id ≠ `prev`), never silently dropped. |
| 3 | **Crash mid-sidecar rename** | The rename is atomic: old sidecar (= FM 2) or new one (consistent). The temp is swept. |
| 4 | **Crash after a REPLACE's rename, before its sidecar** (a compaction / `context_reset` with `keepSuperseded` off, a heal, a reload's first write) | The sidecar's `logHead` is not in the log, so `paired: false`. Load the last segment plus the sidecar state, never resume (a pending ask is closed "Not run"), new lineage, one notice. Today a crash mid-turn closes the turn too. Window: one rename + one small write (~ms) (Q5). |
| 5 | **Crash during a NEW session's first unit** (log, no sidecar) | Never landed, so as today the session does not exist after the restart. Its log goes aside with a notice and the id is free (Q6). |
| 6 | **Log write fails** (ENOSPC, EACCES) | The unit rejects before the sidecar. Reported once (`persister.report`). The store's writer segment still advanced (task 2 rule, `:367-371`), so the next unit heals (append missing / replace). The old sidecar still pairs with the old head. |
| 7 | **Sidecar write fails** (log already appended) | The unit is reported as failed, so the log is ahead (FM 2 on a crash). The next unit appends and writes a sidecar naming the new head, which is consistent. Gated actions after a FAILED write run anyway, as today (`hosted-session.ts:678-680`, `:701-705`: "a failed write is logged … the daemon decides nothing itself"). That gap is today's too (Notes). |
| 8 | **Reload of a live session** | Load the paired pair, reconcile (sidecar `turn`), restart the log lineage from `logHead` (§5). The first write REPLACEs (one rewrite per session per restart, as today's construction write, `:574-576`). |
| 9 | **Reload: turn suspended on its own call's permission** | The sidecar's `pending`, `paired: true`, `resumableTurn` → re-asked, as today. `base.turn` names the resumed turn. |
| 10 | **Reload: any other cut turn** | `reconcileOnReload` with `inFlight`/`pending` → "Interrupted" / "Not run", `RESTART_TURN_END`, steers returned: unchanged. The notes enter the log as `message` entries after the base. |
| 11 | **Archive: `session/close`, idle TTL, detached cap** (one path, P6) | `before` capture (history + turn + its log delta) + `after` keys/stamps + `archivedAt`, one unit. The resident record stays until it lands; a failure is retried by the sweep (heal write). |
| 12 | **Archived rename / reclaim** | Sidecar-only write (`writeState`), read back through `loadState` (no history parse). The log's title catches up at the reopen (Q8). A reopen racing the write keeps `entry.renamed` / `reclaimed` (unchanged logic). |
| 13 | **Reopen** (`session/open{reopen}`) | `prepareOpen` → `persister.load` (log + sidecar) → `restore` → reconcile with `archivedAt` (ENDED notes, never re-asked): unchanged. Lineage continues as FM 8. |
| 14 | **Retry of a failed archive write** | `writeRecord`: heal write if the log part did not land, else sidecar only. Converges at the next sweep. |
| 15 | **Several sessions** | One queue per uid (`session-log-store.ts:334-361`). Units of different sessions interleave freely; within one session they are strictly ordered. |
| 16 | **Store lock** (a second `serve` on the same store) | `acquireStoreLock` unchanged (throws, names the pid). Per-session locks are always free under it (single writer). |
| 17 | **Re-attach after reload: the daemon's copy wins** | `SessionHost.open` of a live id attaches and ignores `messages` / `logBase` (`session-host.ts:446-450`): unchanged. A client reading the log from the held `logHead` → `reseed`. Ahead → content compare → `fork` + aside on that client (the lost unit). `connect` keeps no copy: no effect. |
| 18 | **Compaction / `context_reset`** | `keepSuperseded` off: REPLACE with the new segment (task 2 path). On: one append (Q7). The sidecar after it in both cases. |
| 19 | **The microtask gap at a `context_reset`** (history replaced, not derived yet; a capture there) | `k` is small (maybe 0) and `tail` is the whole new history: exact, one larger sidecar. Rare (task 1 noted the gap: `docs/feat/session-log.md:448`). |
| 20 | **In-place annotation + enqueue before the next commit** | The overlay `k < ref.length` carries the annotated copy: exact (S2). |
| 21 | **Steering window** | Capture = O(n) pointer compare/copy + O(Δ) refs. Stringify, hashing and I/O happen after the persister's first `await` (S3; the existing "no macrotask" test stays green). |
| 22 | **Unreadable / newer files** (corrupt line, unknown log `schemaVersion`, unknown critical entry, unknown `DAEMON_STATE_VERSION`, another project) | `block` + "skipped … (left as is)". The daemon never writes or removes them (`session-persister.ts:79-85`): today's rule, kept (stricter than the laptop, which sets aside then replaces). |
| 23 | **Legacy `<uid>.json`** in the folder | Ignored silently (owner). A tombstone or a new session for the same id is unaffected. |
| 24 | **Version skew** (an older build on this store) | It scans `*.json`: it sees no sessions and may write `<uid>.json` beside our files. This build ignores them. Pre-public, one build (CHANGELOG line). |
| 25 | **`session/delete` cut short** | Tombstone first (unchanged), then sidecar, then log. A log left beside a tombstone is removed at the next start (`serve.ts:234-237`). An orphan sidecar is removed. |
| 26 | **Empty history** (`create`, no prompt yet) | `keepEmpty`: header + `base{create,count:0}` + sidecar, so the session survives a restart as today (probe: 92 constructions with 0 messages). |
| 27 | **Huge prompt in the overlay** | That sidecar is as large as the prompt until the first commit (one round). Bounded by the frame cap. |
| 28 | **Power loss (no directory fsync)** | A rename may be lost, giving an older sidecar (= FM 2) or the old log (= FM 4). Parity with today's `JsonSessionStore` (Q9). |
| 29 | **Pod daemons / worker** | No persister: unchanged. Covered by the existing test that only `startDaemon` persists. |

### Tests (red first; existing seams)

**Seams.**
- `persistence.test.ts`'s `SpyStore` (`:63-116`: hold / release / fail / loads) becomes a
  `DaemonStore` spy holding the TEXT of both files per id. It applies units the way the real store
  does (lines appended, sidecar replaced), decodes with the REAL pure `parseLogFile` + `rebuild`,
  and exposes `durable(id)` as the rebuilt `DaemonSessionRecord`. So the existing assertions
  (`durable.get(id).messages / turn / …`) keep their property and now round-trip through the real
  decoder.
- New spy controls: `crashAt: "afterLog" | "midAppend" | "afterSidecar"` per unit.
- Real-disk tests use `LogSessionStore` in temp dirs (test-env guard `HOME`), and a `Bun.spawn`
  child for the SIGKILL case (task 2 review r4 pattern).

**Red on `main` (headline properties):**
- **S1 — the crash contract across two files** (`daemon/test/serve-log-store.test.ts`, FIRST:
  it pins the load-bearing assumption).
  - Script: a prompt, an ask (pending), the approval, a parallel group (`inFlight`), a steer, a
    compaction, a `context_reset` mid-turn, a rename, a close.
  - At EVERY unit, crash at each of the three points and reload a fresh `SessionHost` from the
    spy. Assert that the reloaded record deep-equals the last LANDED capture (the oracle is
    `persistedState()` captured at that unit). Assert that no tool ran twice (the
    `tool(..., runs)` recorder) and that a pending ask is re-asked only when paired.
  - Red on main: the persister writes `DaemonSessionRecord` JSON, no log/sidecar (the spy's
    decoder fails, "no log").
  - **Mutations:** sidecar written BEFORE the log → a crash `afterLog` reloads state ahead of
    history (fail). Loader folding to EOF instead of `logHead` → `afterLog` reload ≠ oracle
    (fail). Unit resolving after the log only → a call runs before its pending-clearing sidecar
    lands (fail). `resumableTurn` ignoring `paired` → the FM 4 case re-asks (fail).
- **S2 — the overlay.** (a) A crash right after `prompt` accepted (`:1310`) → the reload has the
  prompt. (b) `contextAwareness` on, a tool round, then `session/enqueue` during the next model
  stream → the reload has the annotated message and the steer (in-place, `k < ref.length`).
  - Red on main by construction (no overlay field).
  - **Mutation:** `tail` dropped → (a) fails; `k = ref.length` → (b) fails.
- **S3 — the window stays clean.** With an injected counting `sha256`, and `JSON.stringify`
  spied on through the store io: 0 calls inside `finishTurn`'s synchronous stretch, and the
  digest is computed only after the persister's first `await`. The existing daemon test "no
  macrotask fits between the last steering drain and the turn's end" stays green.
  - **Mutation:** `since()` calling `materialize` → fail.
- **S4 — lineage across a reload (Q12)** (`client/test/reattach.test.ts`, which already builds
  `SessionPersister` + a store at `:565-581`). A `RemoteClient` holds the head, `serve` restarts
  (a new host from the same store), and the client reads → outcome `reseed`, messages = the
  reconciled history. Variant: the client read an unlanded entry → `fork` + aside.
  - Red on main: `adopt` (no `prev` on `base{reload}`).
  - **Mutation:** the base restating the REPAIRED history → `fork` (P5).

**Store / format / paths:**
- **S5** archive / reopen / rename / reclaim on real disk: archived sessions indexed with ZERO
  reads of their `.jsonl` (spied io); reopen closes with the ENDED notes; rename and reclaim
  survive a restart and write only the sidecar (inode of `.jsonl` unchanged).
- **S6** idle TTL and the detached cap archive through the same unit (existing `session-ttl` /
  `session-reaper` / `serve-limits` tests re-pointed, plus one assertion on the sidecar's
  `archivedAt`).
- **S7** several sessions interleaving units (two holds released out of order): each file folds to
  its own session. A second `startDaemon` on the store throws (existing).
- **S8** FM 4 / 5 / 22 / 23 / 25 fixtures: unpaired → closed, not re-asked, a notice; log without
  sidecar → aside, id free; unknown versions / corrupt → blocked, bytes unchanged
  (`shasum` before/after); legacy `.json` ignored; orphan sidecar removed.
- **S9** `keepSuperseded` on serve: a compaction → 1 vs 2 segments, same reload (config pass-through
  test in `serve.ts`).
- **S10** the `prev` containment rule in `LogSessionStore` (shared): a reload base continuing the
  file's last id → no aside; with an unlanded entry after it → one aside holding exactly that
  entry. Laptop store tests stay green (redundant there, P5).
- **S11** real SIGKILL: a child `startDaemon` runs a scripted turn; kill it at random points
  (≥ 200 iterations); restart and check every reload is a landed capture (monotone: the history
  is a prefix of the next run's) and that no tool ran twice.
- **S12** empty session survives a restart (`keepEmpty`); the `/clear` equivalent (a new uid) is
  untouched.
- **S13** `JsonSessionStore` / ladder removal: `agent/test/session-store.test.ts` and the
  `persistence.test.ts` ladder blocks (v1–v7 reads, `kind`/version refusals at `:1355-1365`, the
  v3/v4/v8 gates at `:2231-2300`, `:2547-2700`) are deleted. Their CURRENT-version properties
  (field validation, `head` marking, `inFlight`, steer ids) are re-asserted on the sidecar parser.
  The list of deleted tests goes in Execution.

**Existing tests re-pointed** (≈ 8 files construct a persister or store: `persistence`,
`session-list`, `send-now`, `parallel-agents`, `session-titles`, `serve-autowake` (daemon),
`client/reattach`, `client/foreign-turns`, plus `cli/serve-persistence`). Edited, never weakened:
each re-pointed assertion keeps its property (§9).

**Acceptance (measure, Linux).** Rerun `fsync.mjs` with a "unit" mode (append Δ + sidecar
temp/fsync/rename, sidecar 2 KB / 100 KB) in the `node:22` container, and on a real cluster disk if
one is available. Gate: unit p99 < 5 ms (today's 2 MB rewrite p99 = 5.74 ms). Today's numbers for
the parts: append p99 1.76 ms, 0.4 MB rewrite p99 2.10 ms (upper bound for a sidecar).

**Gate:** `bun run check` (typecheck → lint 0/0 → test; opt-in skips only), AGENTS §6.

### Owner questions (all at once; each with a recommendation and one plain line)

1. **One L task, no split?** — **Yes.** *A split would leave half of `serve` on the old format
   between the two branches; the lineage part is small once the reload is rewired.*
2. **The sidecar keeps the few messages the log has not committed yet (the "overlay"), so a crash
   right after you send a prompt still keeps it?** — **Yes.** *Today's record keeps it; without
   the overlay that prompt would vanish after a crash.*
3. **The sidecar gets its own small version number (`DAEMON_STATE_VERSION`), the log keeps the
   laptop's header version, and `DAEMON_RECORD_VERSION` is deleted?** — **Yes.** *A future change
   to the daemon's state then never makes your laptop's logs unreadable.*
4. **After a crash, the daemon closes a cut turn with today's exact rule (it knows which calls
   were waiting or running), not the laptop's load-time rule?** — **Yes.** *The daemon has the
   exact facts; the laptop rule guesses from markers.*
5. **If a crash hits the few milliseconds of a rewrite (compaction, restart), the daemon loads the
   session but does not re-ask a waiting permission: it marks that call "Not run"?** — **Yes.**
   *It can't prove the two files match there, so it never risks running a tool twice.*
6. **A log with no state file at start (a brand-new session cut by a crash before its first save
   finished) is set aside with a notice, and the session id is free again?** — **Yes.** *Today
   that session would not exist after the crash either; its bytes are still kept.*
7. **`sessions.keepSuperseded` also applies to `serve` (read from the daemon host's own
   config)?** — **Yes.** *One rule for both stores; the default stays "don't keep".*
8. **Renaming or reclaiming an ARCHIVED session writes only the state file; the log's title is
   updated when the session is reopened?** — **Yes.** *No history rewrite for a rename; the list
   shows the new name at once.*
9. **No directory `fsync` after renames (same as today), recorded as debt with a Linux
   measurement?** — **Yes, parity.** *It only matters on a power cut, and today's store has the
   same limit.*
10. **Delete `JsonSessionStore`, `parseSessionRecord`, the v1–v8 record readers and their tests
    (nothing else uses them)?** — **Yes.** *No backward compatibility, so that code only protects
    files you are deleting.*
11. **In the shared log store: a new segment that explicitly continues the file's last line counts
    as "contained" (no aside)?** — **Yes.** *Every `serve` restart would otherwise leave a useless
    aside file; on the laptop it changes nothing.*
12. **Rename `LAPTOP_LOG_FORMAT/VERSION` to `SESSION_LOG_FORMAT/VERSION`?** — **Yes.** *It is no
    longer the laptop's format only.*
13. **`serve` keeps the per-session lock files too (one code path), although its store lock already
    makes it the only writer?** — **Yes.** *Two tiny file operations per save, one less branch to
    get wrong.*
14. **Approve the exact §7 wording in Design §7?** — **Yes.** *It says what this branch makes true,
    no more.*
15. **On restart, the log's new segment restates exactly what was saved, and the restart's own
    fixes ("Interrupted" notes) follow as normal entries, so a reader holding that point sees a
    clean continuation?** — **Yes.** *Otherwise the client's own safety check would treat every
    restart as a fork.*

### Owner answers (2026-11-08, owner asleep — decided by the orchestrator under the owner's overnight delegation; listed in the morning report)
Questions 1–15: **all approved as recommended** (one L task; sidecar overlay; `DAEMON_STATE_VERSION`, `DAEMON_RECORD_VERSION` deleted; daemon closes cut turns with today's exact rule; a rewrite-window crash marks a waiting call "Not run"; orphan log without state set aside; `keepSuperseded` applies to `serve` from the host config; archived rename writes only the state file; no dir fsync (parity, debt); delete `JsonSessionStore`/`parseSessionRecord`/v1–v8 readers; explicit continuation counts as contained; rename to `SESSION_LOG_FORMAT/VERSION`; `serve` keeps per-session locks; §7 wording as in Design §7; restart restates the saved point then appends fixes as normal entries). No `critical` value, entry type or `PROTOCOL_VERSION` change — if Execution finds one is needed, STOP and record it as an open question instead of deciding. Implementation **APPROVED**.

### Notes / debt (deliberate)

- **Failed writes still let a gated action proceed.** `hosted-session.ts:678-680`, `:701-705`:
  this is today's accepted gap, unchanged. A failed sidecar after an approval means a reload can
  re-ask an approved call. Out of scope.
- **`turns` and `enqueueIds` are unbounded** (`hosted-session.ts:1281`, `:1956`; no cap), and the
  sidecar is rewritten at every unit. Estimate: ~70 B per turn key, ~40 B per enqueue id, so
  ~50–110 KB at ~700–1000 turns. Still ≥ 20× smaller than today's per-persist record at that size.
  A cap or moving them into the log is a follow-up (a log type would be an owner `critical`
  decision).
- **No directory fsync** (Q9) on either store.
- **`DaemonSessionRecord.messages` is still copied at each capture** (today's cost). It is needed
  for the overlay and the resident archived record.
- **The Linux numbers are a Docker Desktop VM proxy.** A real cluster disk is a named Execution
  item; Review gets it if Execution has no cluster.
- **`docs/feat/daemon-side-persistence.md` and the other legacy designs** describe the JSON record.
  They get only a pointer line.
- The sketch's "lazy conversion of daemon records ≤ 8" is struck (owner: no conversion).

### Dependencies on task 2 (merged as `3031822`; review round 2 PASS with 4 LOW debt)

This plan builds on, and would need re-checking if any of these changed:
- `LogWrite` and `writeLocked`'s continuation / suffix-append / skip / replace order
  (`session-log-store.ts:421-483`);
- `settleLast` (`:587-629`, the round-1 M1 `ahead` check `:536-547`; a reload's new `inc` never
  trips it, review R2 attack (a));
- `parseLogFile`'s torn-tail rule and its BYTE-offset truncates (round-1 M2: `:557-563`, and
  `readTail`'s byte paths). The daemon reuses them for FM 1. Any new truncate in this task (none
  planned: the loader folds through `logHead`, it does not truncate) must use bytes;
- `TEMP_NAME` / `LOCK_NAME` / `sweep` (`:200-202`, `:801-832`);
- the header (`session-log-file.ts:41-53`, `:404-414`) and `projectEntry` in protocol.

The review's 4 LOW debts (D1–D4) do not touch these surfaces. D1 (the "already kept" clause) is
already in AGENTS §7 on main (`e34466e`). Nothing from task 2's review changes this plan.

## Execution

*— claude-opus-5-5, 2026-11-08*

### Load-bearing proof (first)

- **Probe re-run on HEAD `5a0a54d`** (Appendix A's preload, pointed at this worktree): same 38
  files, 666 pass · 1 skip; **984 captures, 984 exact, 0 in place, overlay 0/1/2 = 883/100/1** —
  identical to the plan. Assumption (i) holds empirically.
- **S1** (`daemon/test/serve-log-store.test.ts`, real disk, written before wiring the rest): a
  scripted life (create, ask, steer, approval, parallel group with `inFlight`, compaction,
  mid-turn `context_reset`, rename, close) is replayed once per io call with a "crash" AT that
  call (an append writes half its bytes; a whole-file write throws before its rename; every later
  call fails). 33 io calls → 34 crash points: 2 absent (first unit never landed), 30 paired (each
  reload deep-equals the last landed capture — messages, turn, keys, ids, head, archivedAt,
  clocks — AND its `logged` equals that capture's log projection), 2 unpaired (only at the state
  file of a compaction / reset REWRITE: the log's new segment loads, never resumed). For every
  reload with a resumable ask, that call never ran before the crash. A clean run asserts every
  unit landed. **Verdict: the assumption holds.**

### As built (plan order)

1. `protocol` — **no change** (`git diff --stat -- packages/protocol` is empty: no `critical`
   value, entry type or `PROTOCOL_VERSION` touched).
2. `session-log.ts`: `since()` (slot references, never materializes), `projection`, public
   `materialize`, `Slot` exported.
3. `session-log-file.ts`: `SESSION_LOG_FORMAT/VERSION` (Q12), `foldThrough` (refuses a head
   inside a base's owed messages), `parseHeaderLine`.
4. `session-log-store.ts`: `LogWrite.sidecar` / `keepEmpty`; the sidecar written atomically after
   the log op in the same queued op + lock (`StateWriteError` names the state file); ops `state`
   (`writeState`), `aside` (`setAside`, FM 5), `dropState` (`removeState`, FM 25); `remove`
   deletes the state file FIRST; sweep knows `.<uid>.state.json.tmp-*`; `readRaw`, `readState`
   (header = first line only), `daemonFiles`; the `prev` containment rule in `settleLast` (Q11).
5. `daemon-state-file.ts` (new, pure): `DAEMON_STATE_FORMAT/VERSION = 1`, `sidecarOf` (overlay by
   reference), `encodeSidecar`, `parseSidecar` (current shape only, strict), `rebuild`.
6. `persisted-session.ts`: `DaemonLogCapture`, `DaemonSessionState.log`, `DaemonSessionRecord`
   without `kind`/`schemaVersion`, with `logged`/`logHead`/`paired`; `PersistedTurn.steeringIds`
   now required; deleted `DAEMON_RECORD_*`, `READABLE_VERSIONS`, `currentTurn`, `withoutIds`,
   `toDaemonRecord`, `parseDaemonRecord` (+ helpers moved into `daemon-state-file.ts`), the
   old-steers branch; `resumableTurn` returns nothing when `!paired`.
7. `session-persister.ts`: the `DaemonStore` seam; a unit = capture (sync) → hand-over on the
   next microtask (wire form, overlay, state text built there) → `store.write`; `archive(id,
   build, at)`, `writeRecord` (heal unit), `writeState`, `load`, `loadState`; `acquireStoreLock`
   unchanged.
8. `hosted-session.ts`: `persistedState(after)` + `logCapture`; `archive(after)` keeps the
   BEFORE log part; the constructor's reload `start(logged, "reload", head)` + `commit`.
9. `session-host.ts`: `restore` passes `log` when paired; `addArchived(ArchivedMeta)`;
   `rewriteArchived` state-file-only for a non-resident entry; sweeps retry those quietly.
10. `index.ts`: exports `daemon-state-file.ts`.
11. `agent/session-store.ts`: `JsonSessionStore`, `SessionStoreIo`, `parseSessionRecord`,
    `ListResult`, `SkippedSession` deleted (Q10); kept `SessionRecord`, `LoadResult`, titles,
    `projectKey`, `isValidSessionId`.
12. `cli/serve.ts`: `LogSessionStore(dir, {keepSuperseded: config.sessions?.keepSuperseded})`,
    asides → `onNotice`; the scan of §6 (orphan state removed; no state → aside; unusable →
    `block` + "skipped <log> / <state>: … (left as is)"; archived → `loadState` only; live →
    `load` + `restore`; an unpaired load gets one notice).
13. Docs: AGENTS §7 (the Design §7 wording, verbatim), `CHANGELOG.md` `[Unreleased]`, the
    `TODO.md` row, the pointer in `docs/feat/daemon-side-persistence.md`.

### Drift from the Implementation (and why)

- **The log cursor lives in the persister, not in `HostedSession`** (`StateBuild = (after?) =>
  state`). A unit dropped before reaching the store would leave the store's writer segment with
  a gap, and only the persister can then reset the cursor (next capture cold → a rewrite).
  Consequence: `persister.archive(id, build, at)` takes the build, not a state.
- **Hand-over on a microtask** (`queueMicrotask`) rather than "after one `await`" — same effect,
  and units reach the store in capture order. Tests that read `store.saves` synchronously now
  `await handed()` (the capture itself is still synchronous, so their property is unchanged).
- **`writeRecord` has no `landedLog` flag**: it always sends a heal unit (no entries, linear from
  `logHead`); the store then skips or appends what the file lacks, then writes the state file.
  Records read from disk never reach it: `rewriteArchived` uses `loadState`/`writeState`.
- **Store API additions** beyond the plan's list: `setAside`, `removeState`, `daemonFiles`,
  `StateWriteError`.
- **Unpaired load ignores the state file's `head`** (it indexes a history that is not the one
  loaded): the reload rule (`legacyHead`) applies. A send-now on a just-compacted summary after
  an FM-4 crash mid-turn may therefore start an unasked turn — rare (FM 4 window ~ms).
- **A real bug found by T4 and fixed**: resolving `Promise.withResolvers` with the store's
  promise ADOPTS it, so every unit read as "not landed" silently (`beforeRun` → false). The
  hand-over is now boxed. S1 got a clean-run assertion so this cannot hide again.
- **S11 runs 200 real SIGKILLs in the default suite** (~14 s, no new opt-in skip): a chain of
  restarts on one store (the child reloads like `serve`, continues turns, is killed at a random
  5–125 ms). Checked: every reload is loadable (never unreadable), each history is a prefix of the
  next, no `run` call ever ran twice.
- **The test seam**: one shared spy, `daemon/test/support/daemon-store-spy.ts` (holds both files'
  TEXT, applies units like the store, decodes with the real `parseLogFile`/`parseSidecar`/
  `rebuild`; `failIf`, `snapshots`, `stateLoads`, `stateWrites`). The client and cli tests import
  it by relative path (precedent: `tui/test` imports `protocol/src`).

### Tests

New: `daemon/test/serve-log-store.test.ts` (S1, S2a/b, S3 ×2, S5 ×2, S7, S8 ×2, S9 ×2, S11, S12,
the state file's parser); S10 ×2 in `daemon/test/session-log-store.test.ts`; S4 ×3 in
`client/test/reattach.test.ts`; FM 5/25 and FM 22 (six unusable variants, both files
byte-identical) and FM 23 in `cli/test/serve-persistence.test.ts`.

Red-first: every new test targets a new seam, so on unmodified code it fails at import/compile,
not on its assertion. Non-vacuity is shown by **one mutation per behaviour** (cp backup → mutate
→ test → restore, `shasum -c` / `cmp` OK each time):

| Mutation | Test | Result |
|---|---|---|
| state file written BEFORE the log | S1 | red |
| loader folds to EOF, not `logHead` | S1 | survived at first → S1 now also asserts `logged`; red |
| unit resolves after the log only | S1 | red ("pending ⇒ never started") |
| overlay `tail` dropped | S2a, S2b | red |
| `k` without the reference compare | S2b | red |
| entries built inside the capture | S3 | red |
| `since()` materializes | S3 | red |
| reload base restates the repaired history | S4 | survived the idle variant → added the repair variant; red |
| archived rename reads the history | S5 | red |
| `resumableTurn` ignores `paired` | S8 | red |
| restore without lineage | S8 | red |
| `prev` containment clause dropped | S10 | red |
| `keepEmpty` ignored | S12 | red |
| `serve` blocks a no-state log instead of setting it aside | FM 5 | red |
| non-atomic rewrite | S11 | red (state file not JSON) |
| state file before the log | S11 | survives (the unpaired fallback is safe by design; S1 catches it) |

Re-pointed, never weakened (S6/S13): `persistence`, `send-now`, `parallel-agents`,
`session-titles`, `session-list`, `serve-autowake` (daemon), `client/reattach`,
`client/foreign-turns`, `cli/serve-persistence`, `agent/session-title-record`.
**Deleted** (they only protected the JSON record / ladder, Q10): `agent/session-store.test.ts`
describes `JsonSessionStore`, `JsonSessionStore durability`, `parseSessionRecord`, `a spilled tool
message in the record`, `JsonSessionStore.remove`, `JsonSessionStore (serve) writes every record`;
`cli/session-resume.test.ts` "parseSessionRecord mirrors the wire ChatMessageSchema";
`agent/session-title-record` "A1 a malformed chosen title" (re-asserted on `parseSidecar`);
`persistence.test.ts` "P-R1 a v3 record reads as v4…", "Q-R2 a v3 turn…", "V5-1", "V6-1",
"V6-2", "V7-1", "V7-2", "V8-1", the v3 part of "Q9", the "older build's head" line of "V8-4";
`send-now.test.ts` "F1a … (v3)"; the ladder part of `session-titles` "D6"; `cli` "S2 a v1 record…"
(replaced by FM 23). Re-asserted on the state file: kind/version → format/`DAEMON_STATE_VERSION`,
wire stamps, `archivedAt`, steer ids, `returned`, pending list / `inFlight`, `head`, title.
"reconcile: steers become user messages" and B6/U3 now expect the steers RETURNED (the
id-less branch is gone).

### Gate

`bunx tsc --noEmit` exit 0 · `bunx biome check .` 734 files, 0 errors / 0 warnings ·
`bun test packages` **5375 pass · 3 skip (the opt-in three) · 0 fail** (375 files).

### Unverified (and how to verify)

- The Linux "unit" measurement (Acceptance, p99 < 5 ms) was not run (no live runs here): rerun
  `fsync.mjs` in unit mode in `node:22` / a cluster disk.
- `serve`'s `keepSuperseded` pass-through has no cli test (one line in `serve.ts`; S9 tests the
  store): verify live (below).
- S6: the TTL / detached-cap archives go through the same `archive()` unit and their existing
  tests pass, but no new assertion reads the sidecar's `archivedAt` there (A13/S1/S5 do for close).
- Archived **reclaim** has no new real-disk test (it shares the state-file-only path with rename;
  the spy-based persistence tests cover it).

### Live checklist (`tentacle serve` + `connect`)

1. `serve`, `connect`, two turns (one with an approved tool); `ls <configDir>/daemon/<project>/`:
   `<id>.jsonl` + `<id>.state.json`, no `<id>.json`.
2. Restart `serve` mid-session (Ctrl-C, start again); `connect --resume`: same history, no fork
   notice / no aside file; continue a turn.
3. `/quit` in `connect` (detach), close the session from another client (archive); rename it
   (`session/rename` via `/sessions`); check `stat` of `<id>.jsonl` unchanged, title in the state
   file; reopen: new title, history intact.
4. Long session → `/compact`: with default config one `base` in the `.jsonl`; set
   `"sessions": {"keepSuperseded": true}` in the serve host's config, restart, compact again:
   two `base` lines; reload identical.
5. Start a turn with a tool needing approval, `kill -9` the `serve` pid while the ask is shown;
   restart: notice "1 resumed a turn waiting for approval", the ask is shown again, approve → the
   tool runs ONCE. Repeat killing during a running tool: "Interrupted" note, no re-run.
6. Put a junk `<x>.state.json` beside a copied `.jsonl`: start notice "skipped … (left as is)",
   bytes unchanged.

### Live test (2026-11-08, orchestrator-run, branch binary, `serve` + `connect`, model `--profile deepseek`)
Sonnet agent in tmux, isolated config dir, report `.tentacle/tmp/session-log-serve-store/live/live-report.md`. 6/6 PASS, no regression vs main:
1. Tool turn: `<uid>.jsonl` + `<uid>.state.json` appear, the log grows during the turn, header stable; detach + `--resume` OK.
2. Daemon restart between turns → resume OK. **Note:** the first write after the restart REWRITES the log (earlier turn markers gone) — to be checked against answer 15 (fix round 1, item 4).
3. `kill -9` serve mid-turn → restart → finished rounds present, cut turn "Interrupted", no tool re-run.
4. `/compact`: 1 base by default, 2 bases with `keepSuperseded`.
5. Archive / list / reopen / delete OK (rename not exercised: no TUI command).
6. Garbage: legacy `.json` untouched; an orphan corrupt `.jsonl` was renamed `.aside` (bytes intact) — the same class as review M2.
*— claude-opus-5-5 (orchestrator), 2026-11-08*

### Fix round 1

*— claude-sonnet-5-5, 2026-11-08*

Against the review's REQUEST-CHANGES and the orchestrator answers (all binding). No `critical`
value, entry type, `LOG_ENTRY_CRITICAL` or `PROTOCOL_VERSION` touched (`git diff -- packages/protocol`
empty).

**M1 — fixed.** `LogSessionStore.forget(id)` (a queued op after the session's units; drops its
writer state; `residentWriters()` for inspection), `SessionPersister.forget(id)` (also drops the
persister's cursor), called by `SessionHost.settleWrite` when an archive unit landed and
`entry.record` is cleared (`session-host.ts`, the `ok` branch). A failed unit keeps the writer (the
sweep's retry heals from it); a resident rename still works and frees it after. `DaemonStore` gained
`forget`; the spy implements it. Tests (`serve-log-store.test.ts`, "M1"): landed archive + resident
rename → 0 writers, state file renamed; failed archive → 1 writer, retry landed → 0. Red on HEAD:
`Expected 0 / Received 1` (the new `residentWriters()` added first, behaviour unchanged). Mutation:
the host's `forget` call removed → both red; restored (`shasum -c` OK).

**M2 — fixed.** `SessionPersister.load` and `loadState` parse the log header BEFORE the
missing-state check; a missing/corrupt header or an unknown `schemaVersion` is a plain failure
(`serve` then `block`s and says "skipped … (left as is)", files untouched). Only a readable header
of this version with no state file is `missingState` (set aside, FM 5). Tests: "M2" ×4 at the
persister (newer, corrupt, other format → refused and NOT `missingState`; current version →
`missingState`, for both `load` and `loadState`), and an end-to-end `startDaemon` test in
`cli/serve-persistence.test.ts` (newer-no-state and corrupt-no-state: bytes identical, no aside,
"skipped … (left as is)"; current-no-state: aside with its bytes). Red on HEAD: the three refused cases
read `missingState` (unit) — `Received: true`. Mutation: the old order restored in `loadState` →
unit ×3 and the e2e red; restored (backup `cmp`/`shasum` OK). Design §6 carries a dated note.

**L1 — done (answer 2).** AGENTS §7 and the Design §7 copy now say: a reload reads the log only up to
the entry the sidecar names (a crash during a rewrite, which leaves no such entry, loads the log's
last segment instead and starts a new lineage), and the archive is "indexed from the sidecar and
the log's first line only". **L3 — done:** the `persisted-session.ts` doc comment on
`ResumedTurn.steeringIds`, the two stale `parseDaemonRecord` mentions in
`cli/test/serve-persistence.test.ts`, and P5's citation (`session-log-reader.ts:209-228`).
**L2:** no change (answer).

**Item 4 (live note 2) — expected, no code change.** After a paired `serve` restart the first write
REWRITES the log: the restarted `HostedSession` starts a new incarnation whose persister has no
cursor (`session-persister.ts:199`), so its first unit is a cold capture (`outcome: "cold"`, from the
`base`); the store cannot continue the old incarnation's last line, so it takes the replace path
(`session-log-store.ts:585`) and `settleLast` treats the file's old segment as CONTAINED because
the new base's `prev` is its last entry (`:722`, answer 11) — dropped without an aside. This is what
the plan says: Design §5 last bullet ("The first write after a reload is a cold capture (from the
base), so a REPLACE … no aside when paired and nothing is unlanded") and FM 8 ("one rewrite per
session per restart"). Answer 15 ("restates the saved point, then the fixes as normal entries") is
met inside that one rewrite: `base{reload}` has `prev` = the landed head, `count` = the landed
projection, and the repair follows as entries (S4 reseeds). What goes is the old segment's non-
projection lines (`turn_start`/`turn_end`/`call_started`/checkpoints): a reader holding the landed
head already reseeds from the base, and turn markers are not needed for a closed session. New
test "FM 8" (`serve-log-store.test.ts`) pins it: one base, `reason: reload`, `prev` = landed head,
`seq` = head+1, no aside, markers of the replaced segment gone, same messages after reload.
Mutation: restore without lineage (`log:` line removed in `restore`) → red; restored.
(A `keepSuperseded` host keeps the old segment through `settleLast`'s keep branch only for
compaction/reset bases, not for a `reload` one — unchanged from the plan.)

**Reviewer repros re-run on the fix** (worktree root):
`r1.test.ts` C: `writers after archive 0 entries undefined chars 0 resident false` (was `1 entries 9
chars 1971`). `r2.test.ts`: `newer-nostate.jsonl: present=true same=true` and "skipped … newer-nostate
… schemaVersion 99 … (left as is)" (was `present=false`, set aside); the with-state cases unchanged.

**Gate:** `bunx tsc --noEmit` exit 0 · `bunx biome check .` 734 files, clean · `bun test packages`
5383 pass · 3 skip (opt-in) · 0 fail.

## Review

*— claude-opus-5-5, 2026-11-08* (round 1, fresh context, code commit `0563664`, base `bd46999`.
Same model family as the executor: only the context is fresh, so shared blind spots can survive
both passes.)

### Verdict: **REQUEST-CHANGES** (0 HIGH · 2 MEDIUM · 3 LOW; not a PASS)

The crash contract holds on every window I attacked. The two MEDIUM findings are outside it: a
memory regression in a long-lived `serve`, and a newer or corrupt log that is moved away although
§7 says it is left untouched.

### Findings

**M1 (MEDIUM) — an archived session's whole log segment stays in the daemon's memory until
`session/delete` or a restart.**
- Where: `session-log-store.ts:264` (`writers`), filled at `:480-504`. It is deleted only at `:476`
  (set aside) and `:779` (remove). `SessionHost.settleWrite` drops the host's own copy
  (`session-host.ts:736-738`), but nothing drops the store's.
- Contract broken: `docs/feat/session-archive.md:382` (the record "is held only until its write is
  confirmed (then dropped…)") and `:441` (peak memory), plus this branch's own comment at
  `serve.ts:234` ("the peak is one history plus the live sessions, however many are kept"). On main
  a landed archive frees the history.
- Failure scenario: a `serve` that runs for months ends 1000 sessions of about 2 MB each (TTL,
  `session/close`, detached cap). About 2 GB of `KnownLogEntry` stays resident until the process
  restarts, although none of those sessions is live.
- Repro (`review/r1.test.ts`, test C), after the archive landed:
  `writers after archive 1 entries 9 chars 1971 resident false` — the host dropped the record, the
  store did not.
- Fix direction: drop the writer's state once an archive unit has landed. A resident rename or
  retry still needs it, so drop it when the host clears `entry.record`. Add a test.

**M2 (MEDIUM) — a log with no state file is moved aside before its header is read, so a newer or
corrupt log is NOT left untouched.**
- Where: `session-persister.ts:368-370` returns `missingState` before `parseHeaderLine` (`:371`);
  `serve.ts:250-254` then calls `setAside`, which removes the `.jsonl`.
- Contract broken: AGENTS §7 (`AGENTS.md:270`, "an unknown one of either is refused and the files
  are left untouched (never written by that daemon)") and FM 22 ("The daemon never writes or removes
  them"). Design §6 lists "sidecar absent" first, so the plan's order produced the contradiction,
  and neither its FM table nor its tests caught it (FM 22's fixtures all have a state file).
- Failure scenario: a log written by a newer build (`schemaVersion` 2) has no state file (its first
  unit was cut, or a later layout does not use one). Starting this build renames it to
  `.aside` and frees the id; going back to the newer build finds no session. Bytes are kept, so it
  is recoverable by hand.
- Repro (`review/r2.test.ts`, real `startDaemon`), planted `newer-nostate.jsonl`, schema 99:
  `set …/newer-nostate.stale-…aside aside: a log with no state file…` and
  `newer-nostate.jsonl: present=false`. With a state file the same log is correct:
  `newer-state.jsonl: present=true same=true`, "skipped … (left as is)".
- Fix direction: parse the header first. Only a readable header of this version with no state file
  is FM 5; anything else is `block` + "skipped … (left as is)". Owner question 1.

**L1 (LOW) — the §7 wording says slightly more than the code does (the owner asked for "no more,
no less").**
- `AGENTS.md:198-199` "continuing each session's log lineage" and "a reload reads the log only up
  to the entry the sidecar names" are unconditional, but an unpaired load (FM 4, Q5) reads the last
  segment and starts a new lineage (`daemon-state-file.ts:380-385`, `session-host.ts:774-775`).
- `AGENTS.md:206` "indexed from the sidecar only": the index also reads the log's first line for
  `cwd`/`createdAt` (`session-persister.ts:371-394`).
- Failure scenario: a later change relies on "a reload always continues the lineage" and treats a
  `base{reload}` without `prev` as a bug. Owner question 2 (the wording was approved verbatim).

**L2 (LOW) — an archived session with a corrupt or unknown-critical log is only refused at its
reopen.** The approved index reads no history (§6, S5), so the scan lists it. A rename is written
beside it and the reopen is refused, with the reason going to `onError` only. Bytes stay untouched
(`review/r1.test.ts` E: `reopen refused`, log unchanged). No change requested; recorded so it is
not read as item 4's "skipped with a message" at start.

**L3 (LOW) — stale references.** `persisted-session.ts:296` still says ids are "absent from an older
record (minted at the reload)"; `cli/test/serve-persistence.test.ts:144`, `:403` name the deleted
`parseDaemonRecord` in their mutation notes. P5's citation has drifted: the reseed decision is at
`session-log-reader.ts:209-228`, not `:216-239` (the premise itself is true).

### Gate (re-run by the reviewer, before any mutation)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0 |
| `bunx biome check .` | 734 files, no findings |
| `bun test packages` run 1 | 5375 pass · 3 skip (the opt-in three) · 0 fail · 61319 expects · 375 files |
| `bun test packages` run 2 | identical (5375 · 3 · 0) |

### Mutations (cp backup → mutate → test → restore; `shasum -c` OK on all files, `git status` clean)

| # | Origin | Mutation | Test | Result |
|---|---|---|---|---|
| 1 | executor | the loader folds to the end of the file, not `logHead` (`rebuild`) | S1 | **red** (`:400`) |
| 2 | executor | `resumableTurn` ignores `paired` | S8 | **red** (`:703`) |
| 3 | reviewer | the reload's `log.commit(session.messages, …)` removed (`hosted-session.ts`, the line Q15 stands on) | S4 "with a repair" | **red** (`reattach.test.ts:2091`) |

### Premise table (`git show bd46999:…`)

| Premise | Verdict |
|---|---|
| Context: `serve.ts:122` builds `JsonSessionStore` | TRUE |
| `hosted-session.ts:808-812` persist, `:895` whole-history copy | TRUE |
| `persisted-session.ts:53` `DAEMON_RECORD_VERSION = 8` | TRUE |
| P3 repair only appends (`:497-513`), a resumed turn leaves history untouched (`:650-653`) | TRUE |
| P4 the constructor `start(...)` (`:513-524`) | TRUE |
| P5 lineage rule | TRUE, citation drifted (L3) |
| P8 `TEMP_NAME`, empty-history skip, containment line (`session-log-store.ts:200-202`, `:430-432`, `:614`) | TRUE |
| P9 the `.lock` store lock is not swept | TRUE (attack L below) |
| proof 1 the in-place annotation (`agent.ts:1156`) | TRUE |

### Attacks tried (scratch: `.tentacle/tmp/session-log-serve-store/review/r1.test.ts`, `r2.test.ts`; real disk, real store and host)

| # | Attack | Result |
|---|---|---|
| A | A crash at every one of the 18 io calls, `keepSuperseded` off and on, then two more generations (reload, continue, reload) | Holds: every reload loads, generation 3 equals what generation 2 served, `g3=paired`. Unpaired only at a rewrite's state file (`at=14`, off). Log-ahead content went aside (`asides=1`), none silently dropped. The harness's one flagged row (`at=2`) is FM 5 (log, no state), expected |
| B | Three clean restarts, `keepSuperseded` on | Holds: same file size (3440 ×3), 2 bases, no aside, `tail` empty |
| C | Memory after an archive | **M1** |
| D, r2 | Newer, corrupt, unknown-state-version and unknown-critical files through the real scan | Holds with a state file (bytes identical, "skipped … (left as is)"); **M2** without one. Legacy `.json` ignored |
| E | Archived + unknown critical entry, rename, reopen | L2; log bytes unchanged |
| F | The archive unit's log op fails (ENOSPC), then the heal | Holds: paired, archived, history exact |
| H1 | A waiting call across a restart | Holds: `base.prev` = saved head, `seq` +1, `base.turn` = the turn; re-asked; approved once, ran once; no re-run at the next restart |
| H2 | Crash in the reload's rewrite window before the state file | Holds: unpaired, tool message "Not run…", never re-asked, 0 runs |
| I | A prompt only in the overlay (`k 0`, `tail 1`), two restarts | Holds: one copy, paired |
| J, K | Idle TTL and detached cap (S6's gap) | Holds: `archivedAt` stamped in the state file through the unit |
| K | Reclaim on a non-resident archived session (the doc's unverified item) | Holds: only the state file changes (`["r2"]`, log identical) |
| L | Dead pid's state temp and per-session lock | Swept; the store's `.lock` untouched |
| r2 | Delete and list | `removed [gone.jsonl, gone.state.json]`, only `deleted-sessions` added; `session/list` right for live and archived |
| Static | `git diff` of `packages/protocol`, `connection.ts`, transport, client `src` | Empty: no `critical`, entry type, `PROTOCOL_VERSION` or RPC change. `hosted-session.ts` adds no `await`; the capture stays synchronous |
| Static | Deleted JSON code | No caller in `packages/*/src`; only the comments of L3 |
| Static | Task 2 M1/M2 | `ahead` check at `session-log-store.ts:623-626`, byte offset at `:647`; store and file tests 42 pass |

Sidecar growth: 1000 turn keys = 82 KB, 1000 enqueue ids = 39 KB (the doc estimated ~70 B and
~40 B each): consistent with its Notes.

### What holds

The two-file crash contract, "pending on disk ⇒ never started", the overlay, lineage (answer 15),
one archive path, sidecar-only rename and reclaim, delete, the store and per-session locks, and the
synchronous capture.

### Not verified by this review

- Linux "unit" latency (Acceptance, p99 < 5 ms): not run, as Execution also says.
- The live `serve`/`connect` checklist: not run.
- `serve.ts` passing `keepSuperseded` from the config is checked by reading only; the store and host
  behaviour was run with both values.

### Executor behaviour

Honest and thorough: the drifts, the mutation that first survived, and its own unverified items are
all in Execution, and every claim I re-ran matched. Its miss is M2, where Design §6's ordering
contradicted FM 22 and §7, plus M1, which the plan's memory analysis did not cover.

### Owner questions (all of them)

1. **A log with no state file but a newer version or a corrupt header: leave it untouched and skip
   it with a message, instead of moving it aside?** — **Yes.** *A file this version cannot read
   should stay exactly where it is; only a session that really was cut before its first save gets
   moved.*
2. **Reword §7 so it says that a crash during a rewrite loads the log's last segment and starts a
   new lineage, and that the archive index also reads the log's first line?** — **Yes.** *The rule
   should describe the rare crash case too, not only the normal one.*

### Orchestrator answers to the review (2026-11-08, under the owner's delegation; in the morning report)
1. **Yes** — a log with no state file but an unreadable/corrupt header or an unknown `schemaVersion` is left untouched and skipped with a message; only a readable header of this version with no state file is FM 5 (set aside).
2. **Yes** — reword §7: a crash during a rewrite loads the log's last segment and starts a new lineage; the archive index also reads the log's first line.
M1: fix as the reviewer suggests (drop the store's writer state when the host clears `entry.record`), with a test. L1 via answer 2; L3: fix the stale references; L2: no change.
No `critical` value, entry type or `PROTOCOL_VERSION` change.

## Appendix A — probe (gitignored scratch, pasted per AGENTS §6)

`.tentacle/tmp/session-log-serve-store/probe-preload.ts`, preloaded into existing tests (no repo
file touched). Note: the `exact` column is true by construction (`k` is a common prefix). The
facts the probe measures are `inPlace` (whether `k < log length`) and `tailLen`.

```ts
// Probe (feat/session-log-serve-store, load-bearing assumption): at EVERY capture the
// serve persister makes (`HostedSession.persistedState`), can the captured history be
// rebuilt EXACTLY (by reference) from (a) the session log's entries through its tip and
// (b) a sidecar holding `k` = the longest reference-common prefix with the log's
// projection and `tail = messages.slice(k)`? Preloaded into existing daemon/cli test
// files; no repo file is touched. Usage (repo root):
//   bun test --preload ./.tentacle/tmp/session-log-serve-store/probe-preload.ts <test files>
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { HostedSession } from "../../../packages/daemon/src/hosted-session.ts";
import { replayFromBase } from "../../../packages/daemon/src/session-log.ts";

const out = join(import.meta.dir, "probe2.jsonl");
const proto = HostedSession.prototype as any;
const original = proto.persistedState;
proto.persistedState = function (this: any) {
  const state = original.call(this);
  const msgs: unknown[] = state.messages;
  const entries: unknown[] = [];
  let after: unknown;
  for (;;) {
    const page = this.log.read(after, 1 << 30, this.logSha256);
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (!page.more || last === undefined) break;
    after = { seq: last.seq, id: last.id };
  }
  const folded = replayFromBase(entries as never) as unknown[];
  let k = 0;
  while (k < folded.length && k < msgs.length && folded[k] === msgs[k]) k++;
  const tail = msgs.slice(k);
  const rebuilt = [...folded.slice(0, k), ...tail];
  const exact = rebuilt.length === msgs.length && rebuilt.every((m, i) => m === msgs[i]);
  const frames = (new Error().stack ?? "").split("\n").slice(2, 14).map((l) => l.trim());
  const site = frames
    .filter((f) => f.includes("hosted-session.ts") || f.includes("session-host.ts"))
    .map((f) => (f.match(/(hosted-session|session-host)\.ts:(\d+)/) ?? []).slice(1).join(":"))
    .slice(0, 3)
    .join(" < ");
  appendFileSync(out, `${JSON.stringify({ site, logLen: folded.length, msgLen: msgs.length, k,
    tailLen: tail.length, inPlace: k < folded.length, exact })}\n`);
  return state;
};
```

Run (main, tree as of this plan):
```
bun test --preload ./.tentacle/tmp/session-log-serve-store/probe-preload.ts packages/daemon/test \
  packages/cli/test/serve-persistence.test.ts packages/cli/test/serve-limits.test.ts \
  packages/cli/test/serve-resident.test.ts packages/cli/test/serve-autowake.test.ts \
  packages/cli/test/context-reset-e2e.test.ts
 666 pass · 1 skip · 0 fail · Ran 667 tests across 38 files.
```
Summary (`jq -s` over `probe2.jsonl`):
```
{"captures":984,"exact":984,"inPlace":0,
 "tailHist":[{"tail":0,"n":883},{"tail":1,"n":100},{"tail":2,"n":1}],"inPlaceSites":[]}
```
An earlier run of the same probe over 8 files (746 captures) found non-empty tails only at these
sites: `hosted-session.ts:1310` (turn accepted: `[user]` ×86, `[user, assistant]` ×1), `:1490`
(send-now start: `[user]` ×5), `:851` (`beforeRun`: `[user]` ×2). Every other site (`:576`
construction, `:1601` commit, `:1721` turn end, `:677`/`:700` asks, `:1029`, `:1959` enqueue,
`:2138`/`:2140` archive, …) had an empty tail.
