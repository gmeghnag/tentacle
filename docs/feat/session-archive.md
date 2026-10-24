# feat/session-archive — idle sessions are archived, never deleted

> **Status:** implementation (plan approved by the owner 2026-10-23 — answers: Q1 the detached cap ARCHIVES the oldest idle detached session (never a busy one) instead of refusing; Q2 `DAEMON_RECORD_VERSION` 1→2, v1 records read as not archived; Q3 a runtime TTL change is not persisted (task 2b); Q4 split: 2b `feat/session-ttl-control` FIRST, then this task 2a)
> **Branch:** `feat/session-archive`
> **Size:** M–L · **Blast:** load-bearing (AGENTS §7 "Persistence", a protocol meaning change + `PROTOCOL_VERSION` bump, a persisted-format bump, the session lifecycle every runtime shares) · **Suited:** strong model executes; mandatory fresh-context Review red-teaming §7 "Persistence", "Protocol" and "Don't serialize the RPC peer"

Type: feat · Size: M–L · Blast: load-bearing · Suited: strong model + mandatory fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-23*

Task 2a of `docs/eval/mobile-app.md` decision 21 row 2 ("Idle TTL archives
instead of deleting; `--session-ttl never`; explicit delete — M ·
load-bearing"), split by the owner: the TTL half (`never`, runtime change) is
task 2b, `docs/feat/session-ttl-control.md`, merged BEFORE this one. This task
implements the rest of decision 4 on top of task 1 (`session/list`, merged,
`docs/feat/session-list.md`).

Owner decisions this task implements (final):

- **4 — Idle TTL archives, never deletes.** After the TTL the daemon unloads the
  session, stops its background jobs and KEEPS its record as *archived*; it is
  listed as archived; opening it reloads it with full history, as on a `serve`
  restart. The `--max-detached-sessions` cap archives too (Q1: the oldest idle
  detached session, never a busy one, instead of refusing).
- **4 — Ending is explicit; deletion is manual only.** "End session" /
  `/close` ends a session; "Delete" removes it. No automatic purge, ever.
- **5 — every client is a view of the session**: an archive / reopen / delete
  must converge on every attached client.
- **6 — one daemon per project**: entries carry their `cwd` (task 1 Review
  nit 4: `toSessionList` takes ONE `cwd` for every entry,
  `packages/daemon/src/session-list.ts:65-72` — archived records carry their
  own `record.cwd`).
- **Q2** — record format 1→2, v1 read as not archived.
- AGENTS §7: pod daemons and the in-process worker never persist.

Out of scope: the TTL value and its runtime change (2b), titles (task 3), any
TUI / `connect` UI (`/sessions`, `/close`, "Delete" — task 7), the app (11).

Today (verified on `main`, worktree snapshot `main-ro`):

- `SessionHost.close` deletes the map entry, closes, then
  `persister.remove(id)` (`packages/daemon/src/session-host.ts:170-181`). The
  reaper's sweep IS `close` (`session-host.ts:249-274`). Pinned by `A9`
  (`packages/daemon/test/persistence.test.ts:878`) — this task inverts it.
- `session/close` is documented as "end the session for everyone … forget it"
  (`packages/protocol/src/session.ts:293-304`); `session/open` of a non-live id
  is `UnknownSession`, "the daemon lost it (a restart, a close)"
  (`session.ts:260-261`).
- `session/list`'s `archived` is "Always false for now" (`session.ts:370`,
  `session-list.ts:85`).
- **There is no eviction today.** `--max-detached-sessions` REFUSES a new
  session (`TooManySessions`): "nothing is evicted (owner decisions G, D6)"
  (`session-host.ts:214-247`). Q1 replaces the refusal with an archive.
- At start `serve` reads EVERY record fully and keeps them all in memory at
  once (`store.list()` accumulates `records[]`,
  `packages/agent/src/session-store.ts:437-461`; called at
  `packages/cli/src/serve.ts:134`). Harmless while every record becomes a live
  session anyway; unbounded once archived records are kept forever. Measured
  below: time is fine, peak memory is not.

**Repro** (2026-10-23, run from `.tentacle/tmp/session-archive-plan/`). Caveat:
the `@tentacle/*` imports resolved through the repo root's `node_modules`, i.e.
the PRIMARY checkout, which carries another task's uncommitted changes — the
code paths exercised (`close`, `reapExpired`, `restore`, `list`) were read
identical on `main-ro`, but the executor MUST re-run all three scripts on a
clean `main` before any edit (`docs/EXECUTOR-BRIEF.md`).

```ts
// repro.ts — today session/close and the idle reaper DELETE the daemon record.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost, SessionPersister } from "@tentacle/daemon";

const dir = mkdtempSync(join(import.meta.dir, "store-"));
const store = new JsonSessionStore(dir);
const persister = new SessionPersister({
  store, cwd: "/w", model: "m", onError: (e) => console.log("err", e.message),
});
let now = 1_000_000;
const host = new SessionHost({
  defaultCwd: "/w", persister, now: () => now,
  createAgent: () => ({ agent: {} as never, permissions: new PermissionBroker() }),
});
const att = { send: () => {} };
const a = host.open({ create: true, messages: [{ role: "user", content: "keep me" }] }, att).hosted;
const b = host.open({ create: true, messages: [{ role: "user", content: "idle me" }] }, att).hosted;
await store.drain();
console.log("on disk after open:", existsSync(join(dir, `${a.id}.json`)), existsSync(join(dir, `${b.id}.json`)));
host.close(a.id);
b.detach(att);
now += 10_000;
console.log("reaped:", host.reapExpired({ idleTtlMs: 5_000 }).length);
await persister.stop();
console.log("on disk after close / reap:", existsSync(join(dir, `${a.id}.json`)), existsSync(join(dir, `${b.id}.json`)));
console.log("list:", JSON.stringify(host.list({})));
rmSync(dir, { recursive: true });
process.exit(0);
```

```
$ bun repro.ts
on disk after open: true true
reaped: 1
on disk after close / reap: false false
list: {"sessions":[]}
```

```ts
// startup-cost.ts — what a start-time JsonSessionStore.list() of N records costs.
// For [n, kb] in [[200,200],[1000,200],[1000,1000]]: write n files whose
// `messages` are kb × 1 KB entries, then time `await new JsonSessionStore(dir).list()`
// and print the rss delta.
```

```
$ bun startup-cost.ts
200 records x 200 KB: list() 26 ms, 200 loaded, rss +77 MB
1000 records x 200 KB: list() 104 ms, 1000 loaded, rss +255 MB
1000 records x 1000 KB: list() 377 ms, 1000 loaded, rss +1107 MB
```

→ a full read at start is fast enough (< 0.4 s for 1 GB of records); holding
them all at once is not (1.1 GB). The bound this task needs is on **peak
memory**, not on the read: stream the records one at a time, keep only
metadata for archived ones, read nothing from disk per `session/list`.

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Builds on (must be merged first) — and what to re-verify

**Task 2b `feat/session-ttl-control`** (merged before this branch is cut). This
task relies on exactly these 2b results (`docs/feat/session-ttl-control.md`
§Design); re-cite their real `file:line` on the post-2b `main` before Execution:

- `ReapPolicy.idleTtlMs: number | null` and `expiry`'s `null` branch in
  `packages/daemon/src/session-reaper.ts` (today `:20-25`, `:69-80`) — this task
  adds `selectEvictable` next to `selectExpired` in the same file.
- `sweepIntervalFor` moved into `session-reaper.ts` (today `serve.ts:29-42`),
  and `listen`'s re-armable reaper in `packages/cli/src/serve.ts` (today
  `:171-213`) — this task only changes the audit wording inside it.
- `Method.SessionTtl` in `packages/protocol/src/methods.ts` and its dispatch
  case in `packages/daemon/src/connection.ts` — this task adds `SessionDelete`
  next to them (merge-adjacent, no semantic overlap).
- 2b adds no record field and no `PROTOCOL_VERSION` change, so the bumps below
  are this task's own.

**Task 4a `session/send_now`** (branch `feat/send-now-a`, merges before 2b and
2a). It edits `daemon/src/hosted-session.ts`, `daemon/src/connection.ts`,
`protocol/src/methods.ts`, `protocol/src/session.ts`. After it lands, re-verify
(each is a premise below; a mismatch → STOP and fix this plan, AGENTS §8):

1. `HostedSession.close()` still aborts → `turn_end{cancelled}` →
   `session_closed` → detach → `jobs.dispose()` (today
   `hosted-session.ts:964-993`), and `persist()` is still a no-op once closed
   (`:470-475`).
2. `persistedState()` (today `:486-511`) still captures EVERY state a reload
   needs: if 4a adds a persisted piece (e.g. a queued send-now), the archive
   capture carries it for free (it is `persistedState()`), but
   `reconcileOnReload`'s ended-turn branch (below) must handle it, and the
   record v2 must describe it. Check `rg "this.persist\(\)" hosted-session.ts`
   for new sites.
3. The busy slot is still `controller !== null` (`running`, today `:513-516`;
   a suspended turn sets it, `:299`) and `liveness().busy = running`
   (`:540-549`) — the "a suspended turn is never idle" fact. If 4a adds a
   second kind of activity, decide whether it is busy.
4. `Connection.open` is still synchronous and calls `host.open` once (today
   `connection.ts:273-291`), and `closeSession` still `attached.delete` +
   `host.close` (`:305-309`).
5. `PROTOCOL_VERSION` (today `10`, `protocol/src/version.ts:7`): if 4a bumps,
   this task takes the next number.
6. `session.ts` `session/open` / `session/close` doc blocks (today
   `:250-304`) — this task rewrites them; rebase onto 4a's wording.

### Load-bearing assumption

**Unloading a session and later `restore`-ing the record it would have written
yields the session a `serve` restart yields — so "archived" needs no new reload
path: only a record that is not restored at start, an in-memory index of it,
and a way to restore it on `open`.** Proof:

- The restart path is `parseDaemonRecord` → `SessionHost.restore(record)`
  (`packages/cli/src/serve.ts:144-158`); `restore` is synchronous, needs only
  the record and the host (`session-host.ts:193-212`), and is not tied to
  daemon start (it refuses only an id that is already live, `:194-196`).
- A record is a synchronous capture of `persistedState()`
  (`packages/daemon/src/hosted-session.ts:486-511`, through
  `SessionPersister.schedule` → `toDaemonRecord`,
  `packages/daemon/src/session-persister.ts:64-101`), so the state can be
  captured right before `close()` aborts anything.
- Cheap test (2026-10-23, `.tentacle/tmp/session-archive-plan/reload.ts`; same
  caveat as the Repro — re-run on clean `main`): open a 3-message session in a
  LIVE host, drain, load its file, unload it WITHOUT the delete (registry
  delete + `close()`), `restore` the parsed record into the same running host:

  ```ts
  const { hosted } = host.open({ create: true, messages }, att);
  const before = hosted.snapshotPage(undefined, undefined);
  await store.drain();
  const loaded = await store.load(hosted.id);           // status "ok"
  (host as unknown as { sessions: Map<string, unknown> }).sessions.delete(hosted.id);
  hosted.close();
  const parsed = parseDaemonRecord({ ...loaded.record }, () => true);
  const again = host.restore(parsed.record);
  const after = again.snapshotPage(undefined, undefined);
  ```

  ```
  $ bun reload.ts
  same id: true | new object: true
  history equal: true (3 messages)
  new epoch: true
  listed: [["first",false]]
  ```

  Full history, a fresh epoch (every returning client resyncs — the restart
  contract, `session-host.ts:189-191`), listed again. The restart path works
  mid-life.

Second fact the failure modes stand on — **a turn suspended on a permission is
never idle**: the suspended/resumed turn holds the busy slot
(`this.controller = new AbortController()`, `hosted-session.ts:299`;
`running` = `controller !== null`, `:513-516`), `liveness().busy = running`
(`:540-549`), and `idle_ttl` requires `!s.busy` (`session-reaper.ts:73`). So only
the opt-in admin cap (`:76`) or an explicit close can archive a busy session —
and the detached-cap eviction never does (Q1). Re-verify after 4a (item 3).

### Preconditions

- **Single writer per store**: `acquireStoreLock` (`session-persister.ts:152-207`,
  taken at `serve.ts:86`) — "two daemons" cannot share one store; archived
  records live in the same directory, so the same lock covers them.
- **Per-id write order is latest-wins and a removal is in the same queue**
  (`packages/agent/src/session-store.ts:243-244`, "a queued deletion: in the
  same per-uid queue as saves"). So archive-write → restore-write, or
  archive-write → delete, land in call order.
- **`SessionHost.open` / `close` / `restore` / `reapExpired` are synchronous on
  purpose** (comments at `session-host.ts:144-150`, `:183-192`, `:249-256`).
  The only new async step (a disk load) must stay OUTSIDE those sections.
- **Requests dispatch concurrently** (AGENTS §7, `transport/src/peer.ts`); an
  `await` inside one handler is fine, a lock across handlers is not.
- **`HostedSession.close()`** aborts the turn, emits `turn_end{cancelled}` +
  `session_closed`, detaches all, disposes jobs (`hosted-session.ts:964-993`);
  after `closed = true` every `persist()` is a no-op (`:470-475`).
- **The client never reads `session_closed.reason`**
  (`packages/client/src/mapping.ts:204`, `session-reducer.ts:257-258`,
  `remote-client.ts:1129`) — a new enum value breaks no client logic, only an
  older client's schema parse (hence the bump below).
- **`session_closed` is `mandatory`** (`packages/protocol/src/updates.ts:187`).
- **Extra top-level record fields survive the store's parse**
  (`session-store.ts:201-205`, "Extra top-level fields are kept as-is"), and `parseDaemonRecord` refuses an unknown
  `schemaVersion` (`persisted-session.ts:150-155`).
- **Pod daemons and the worker have no persister and no reaper**
  (`serve.ts:224-302`: no `persister`, no limits, no `startReaper`;
  `packages/cli/src/worker.ts:91`).
- **Callers of `session/close` today**: `RemoteSession.close`
  (`packages/client/src/remote-session.ts:78-92`) and
  `RemoteClient.closeSessions` on quit (`packages/cli/src/connect.ts:134`,
  `packages/cli/src/local-runtime.ts:272`). On a `serve` daemon, `connect`'s
  quit therefore ARCHIVES after this task instead of deleting (aligned with
  decision 4; task 7 turns quit into a detach).

### Design

#### Lifecycle (one id is in exactly ONE state at a time)

```
            open{create}                      reaper idle_ttl / admin_cap
  (none) ───────────────▶ LIVE ─────────────────────────────────────▶ ARCHIVED
     ▲                    │  ▲  session/close, detached-cap eviction      │
     │  session/delete    │  └────────── session/open{sessionId} ─────────┘
     └────────────────────┴──────────────── session/delete ◀──────────────┘
```

- LIVE = in `SessionHost.sessions` (today). ARCHIVED = in a new
  `SessionHost.archived: Map<string, ArchivedEntry>` (metadata only, or the
  full record while its write is unconfirmed). Every transition is ONE
  synchronous step in `SessionHost`, so `list`/`open`/`close`/`delete` stay
  lock-free consistent reads (§7). Invariant pinned by a test: no id is ever in
  both maps.
- **Non-persisting runtimes** (pod `serve --stdio`, worker): there is no
  ARCHIVED state. "Archive" degenerates to today's close (nothing kept),
  `delete` of a live id = close with reason `deleted`, `list` never has
  `archived: true`, no eviction (they set no limits). Exactly today's behaviour.

#### Wire (protocol) — `PROTOCOL_VERSION` 10 → 11 (or 4a's + 1)

- **`session/close` changes meaning**: "end the session for everyone (abort
  its turn, stop its jobs, `session_closed{closed}`); on a daemon that
  persists, keep it ARCHIVED (listed, reopenable); elsewhere it is gone.
  Idempotent: an unknown, archived or already-closed id is a no-op success."
  Shape unchanged.
- **`session/open` changes meaning** for an archived id: it is reloaded (full
  history, `created: false`, `resync: true` — a new epoch, so the client
  snapshots), whatever `create` / `messages` say (the daemon's copy wins, like
  a re-attach after a restart, AGENTS §7 Persistence). `UnknownSession` now
  means "not live and not archived (deleted, unreadable, or never existed)".
- **New `session/delete`** `{ sessionId }` → `{}`: end it if live
  (`session_closed{deleted}`) and remove its record; remove an archived one.
  Idempotent (unknown → no-op success). Needs no prior `open`. Same
  authorisation as `close` (one token = one principal, `session.ts:266`;
  per-device auth is task 9). A record the daemon could not load (corrupt,
  newer version, other project) is hidden and never touched — not deletable
  through RPC; the start notice names its file for manual removal (unchanged
  policy, `serve.ts:135-151`).
- **`session_closed.reason`: `["closed", "deleted"]`** (`updates.ts:132-135`) —
  so a view (app, task 11) can say "deleted on another device" and drop it
  from its list instead of showing it archived.
- **`session/list`**: `archived` doc becomes "persisted, not loaded: open it to
  reload" (`session.ts:370`). `cwd` is per entry. Shape unchanged.

**Why a bump** (AGENTS §7 "truly breaking: a changed meaning"): `close` no
longer forgets, `open` of a closed id no longer fails, and a v10 client would
fail its schema parse on `reason: "deleted"` in a `mandatory` update.
Pre-public: no shims, no capability negotiation — a mixed pair fails at
`initialize` with `VersionMismatch`. (`session/delete` alone would be additive.)

#### Record (on disk) — `DAEMON_RECORD_VERSION` 1 → 2 (Q2)

- New optional `archivedAt: number` (wire stamp, `isWireStamp`,
  `persisted-session.ts:94`) on `DaemonSessionRecord` / `DaemonSessionState`
  (`:41-60`), spread by `toDaemonRecord` (`:63-83`). Present ⇔ archived.
- **Why the bump**: a v1 daemon ignores unknown fields and would restore EVERY
  archived record live at start (`serve.ts:144-158`; restores are never refused
  by the limits, `session-host.ts:190-191`) — hundreds of live agents after a
  downgrade. With v2 an older daemon refuses each record and leaves it
  untouched (`persisted-session.ts:150-155`): loud, never half-loaded.
- **v1 is read as v2 without `archivedAt`** (today's sessions stay live after
  the upgrade); every write is v2. One branch in `parseDaemonRecord`.

#### Daemon

- **`HostedSession`** (`hosted-session.ts`):
  - `close(reason: "closed" | "deleted" = "closed")` → emits
    `session_closed{reason}` (today `:986`).
  - `archiveState(): DaemonSessionState` — the public face of
    `persistedState()` (`:486`). Captured BEFORE `close()`, so a busy session's
    record keeps its `turn` (pending, steering) — exactly the shape a crash
    leaves, which the reload already reconciles.
  - `summary()` (`:528-538`) gains `cwd` (the host's `defaultCwd`, passed in)
    and `archived: false`.
- **`persisted-session.ts`**:
  - v2 + `archivedAt`; `parseDaemonRecord` accepts `schemaVersion` 1|2, checks
    `archivedAt` with `isWireStamp` when present.
  - `reconcileOnReload(record)` (`:299-337`): when `record.archivedAt !==
    undefined` and `record.turn` is set (closed / admin-capped mid-turn), close
    the turn honestly as **ended**, never resumed: synthetic tool answers with
    new `ENDED_NOT_RUN_NOTE` / `ENDED_INTERRUPTED_NOTE` ("…the session was
    ended before/while…", next to `NOT_RUN_NOTE` & co., `:229-238`), steering
    kept as user messages, the turn key's end `{ stopReason: "cancelled" }`
    (what the live close streamed). A pending permission is NOT asked again —
    the user (or the admin cap) ended the session. Idle archives (the TTL and
    eviction cases: never busy) have no `turn` and reload as is.
- **`session-persister.ts`**:
  - `PersisterOptions.sameProject: (cwd) => boolean` (moved from
    `serve.ts:141-145`).
  - `archive(state, archivedAt): { record: DaemonSessionRecord | null; written: Promise<boolean> }`
    — same capture / queue / `latest` bookkeeping as `schedule` (`:64-101`;
    factor its body into one private `write`), but the caller learns whether
    it landed (`false` on a failed save — reported via `onError` — and
    `record: null`, `written` → `false` for a blocked / invalid id).
  - `load(id): Promise<{ ok: true; record } | { ok: false; reason }>` —
    `await flush(id)` first (a pending write for the id lands before the read),
    then `store.load` + `parseDaemonRecord(…, sameProject)`. `RecordStore`
    (`:23-28`) gains `load`.
- **`session-list.ts`**: `SessionSummary` (`:24-33`) gains `cwd` and
  `archived`; `toSessionList(summaries, params)` drops its `cwd` parameter
  (nit 4). Archived entries: `running: false`, `attached: 0`, `updatedAt` = the
  record's `updatedAt` (= `lastChangeAt` since task 1,
  `session-persister.ts:85-90`), so live and archived sort on the same key
  through the same keyset cursor — no wire change.
- **`session-reaper.ts`**: new pure `selectEvictable(liveness): string | null`
  — the idle (detached, not busy) session with the smallest `lastActiveAt`,
  ties by id; `null` when every detached session is busy.
- **`session-host.ts`**:
  - `ArchivedEntry = { id, title, cwd, createdAt, updatedAt, record?: DaemonSessionRecord, unwritten?: boolean }`;
    `record` is held only until its write is confirmed (then dropped: memory
    is metadata only).
  - `private archive(id, reason: ReapReason | "closed" | "evicted"): boolean`
    — sync: `state = hosted.archiveState()` (if a persister), `sessions.delete`,
    `hosted.close("closed")`, then `persister.archive(state, now)` →
    `archived.set(id, entry with record)`; `written.then(ok => …)` drops
    `entry.record` iff the entry is still the same object and `ok`; on `!ok`
    marks `unwritten`. Without a persister: just the close (today).
  - `close(id)` = `archive(id, "closed")` (keeps its boolean). `reapExpired`
    keeps calling it — one teardown path (`:249-256`) — and also retries the
    write of every `unwritten` entry (one attempt per sweep, reported once per
    entry until it lands).
  - `delete(id): boolean` — sync: live → `sessions.delete`,
    `close("deleted")`, `persister?.remove(id)`; archived → `archived.delete`,
    `persister.remove(id)`; else `false`.
  - `addArchived(record)` — start time: metadata entry, no record kept.
  - `prepareOpen(params): Promise<DaemonSessionRecord | undefined>` — the ONLY
    async step: if `sessionId` is archived, not live, and its record is not
    resident → `persister.load(id)` (deduplicated per id: concurrent opens
    share one load). Load failure (vanished, corrupt now, other project) →
    `archived.delete`, `persister.block(id)`, report, return `undefined` (the
    open then answers `UnknownSession`; the entry is hidden — task 1's rule).
    Returns the record (or the resident one) **pinned**, so a write
    confirmation that drops `entry.record` in between cannot lose it.
  - `open(params, attachment, prepared?)` stays synchronous. New branch after
    "live → attach" (`:152-156`): `archived.get(id)` exists → record =
    `prepared` (same id) ?? `entry.record`; none →
    `RpcError(UnknownSession, "archived session not loaded")` (reachable only
    if a caller skips `prepareOpen`); else `archived.delete(id)`,
    `restore(record)` (its constructor `persist()`, `hosted-session.ts:306`,
    writes a record WITHOUT `archivedAt`, queued after the archive write),
    attach → `{ created: false, resync: true }`. Not admitted through the
    limits (an attach is never refused, decision G).
  - `list(params)` (`:136-142`) — `toSessionList([...live summaries, ...archived entries], params)`;
    still synchronous, no disk.
  - **Detached cap** (`admit`, `:220-247`, Q1): when
    `detached >= maxDetachedSessions` AND a persister exists →
    `selectEvictable` → `archive(victim, "evicted")` + audit
    `session-archived <id> evicted`, then admit; no idle victim → refuse as
    today (busy sessions are never evicted). Without a persister → refuse as
    today (archive = delete there). The error text drops "close one with
    session/close" for "every detached session is running a turn".
- **`connection.ts`**: `open` (`:273-291`) becomes `async`:
  `const prepared = await this.host.prepareOpen(params)` FIRST, then today's
  synchronous body unchanged (`dropStale`, previous detach,
  `host.open(params, attachment, prepared)`) — the replay/live join stays one
  synchronous segment. New `case Method.SessionDelete` →
  `this.attached.delete(id)`, `this.host.delete(id)`, `{}`.
- **Audit wording**: on a persisting host the reaper's
  `session-reaped <id> <reason>` (`session-reaper.ts:116-118`) becomes
  `session-archived <id> <reason>` (honest; `serve-limits.test.ts` assertions
  follow).

#### `serve` start (`packages/cli/src/serve.ts:108-169`)

- `JsonSessionStore.scan(): AsyncIterable<{ id: string; result: LoadResult }>`
  (new, `session-store.ts`; `list()` (`:437-461`) reimplemented on top of it,
  unchanged semantics, `sweepTemps` kept). `reloadedHost` iterates `scan()`:
  parse → `archivedAt` present → `host.addArchived(record)` (metadata kept,
  record dropped); absent → `host.restore(record)` (today). Peak memory: one
  record + the live sessions (bounded by `maxSessions`) + O(archived) metadata.
- Notice: `restored N sessions, M archived, from <dir>`.

#### Client (`packages/client/src/remote-client.ts`)

- `deleteSession(sessionId): Promise<void>` — same guards / forget logic as
  `closeSession` (`:407-425`).
- `closeSession` doc: "ends it; a persisting daemon keeps it archived".
- No UI (task 7 / 11).

#### Per runtime

| Runtime | TTL / admin cap | detached cap | `close` | `delete` | `list` |
|---|---|---|---|---|---|
| `serve` | archives | archives oldest idle; refuses if all busy | archives (record kept) | ends + removes record | live + archived |
| pod `run`/`attach` (`serve --stdio`) | no reaper (today) | no limits (today) | ends, gone (today) | live → ends (`deleted`); else no-op | live only |
| in-process worker | no reaper (today) | no limits (today) | ends, gone (today) | same as pod | live only |

#### Seams for later tasks (additive)

- **Task 3 (titles):** `ArchivedEntry.title` comes from `record.title`; a
  daemon-owned title lands in the record and the entry reads it unchanged; a
  `/rename` of an archived session updates entry + record (a write, no reload).
- **Task 7 / 11 (UIs):** `RemoteClient.sessionList` (`archived`),
  `session/open` to reopen, `deleteSession`, `session_closed.reason`.
- **Laptop copy:** `session/delete` removes the DAEMON's record only; the
  laptop's own store (`<configDir>/sessions`) is the client's to delete (task 7
  decides the "Delete" UX).

### Files

In dependency order. Shared with 4a: `hosted-session.ts`, `connection.ts`,
`protocol/src/methods.ts`, `protocol/src/session.ts` (rebase after it, then
re-verify §"Builds on"). Shared with 2b: `session-reaper.ts`, `methods.ts`,
`connection.ts`, `serve.ts` (adjacent edits only).

1. `packages/protocol/src/version.ts` — `PROTOCOL_VERSION` + 1.
2. `packages/protocol/src/session.ts` — `session/close` + `session/open` doc
   blocks; new `--- session/delete` section (`DeleteParamsSchema`,
   `DeleteResultSchema`); `archived` doc.
3. `packages/protocol/src/updates.ts` — `SessionClosedSchema.reason` + doc.
4. `packages/protocol/src/methods.ts` — `Method.SessionDelete = "session/delete"`, `RequestSchemas`.
5. `packages/protocol/schema/protocol.json` — `bun run schema:export`;
   fixtures in `packages/protocol/test/json-schema.test.ts` (`:61`).
6. `packages/agent/src/session-store.ts` — `scan()`; `list()` on top of it.
7. `packages/daemon/src/persisted-session.ts` — v2, `archivedAt`, ended-turn reconcile + notes.
8. `packages/daemon/src/session-persister.ts` — `sameProject`, `archive`, `load`, `RecordStore.load`.
9. `packages/daemon/src/session-list.ts` — `SessionSummary.cwd/archived`; drop the `cwd` param.
10. `packages/daemon/src/session-reaper.ts` — `selectEvictable`; audit wording.
11. `packages/daemon/src/hosted-session.ts` — `close(reason)`, `archiveState()`, `summary()` fields.
12. `packages/daemon/src/session-host.ts` — archived index, `archive` / `close` / `delete` / `addArchived` / `prepareOpen` / `open` / `list` / `admit` / `reapExpired`.
13. `packages/daemon/src/connection.ts` — async `open`, `session/delete` case.
14. `packages/daemon/src/index.ts` — exports if needed.
15. `packages/client/src/remote-client.ts` — `deleteSession`, `closeSession` doc.
16. `packages/cli/src/serve.ts` — `scan()` start, `addArchived`, `sameProject` to the persister, notice.
17. Tests (below); `docs/feat/daemon-side-persistence.md` — one paragraph
    ("close archives; delete removes"); AGENTS §7 Persistence bullet gains "an
    archived record is kept until `session/delete`" (a rule-text change, rides
    this branch per AGENTS §10).

### Failure modes

- **Archive while a client re-attaches.** Both are synchronous on the host: the
  sweep first → the session is ARCHIVED and the open reloads it (new epoch →
  `resync: true`; the client snapshots, nothing is lost); the open first →
  attached → `selectExpired` skips it (`session-reaper.ts:70-72`). The open's
  only async part (`prepareOpen`) runs before the synchronous body, which
  re-checks live / archived. A connection attached to the old incarnation drops
  it via `dropStale` (`connection.ts:293-302`).
- **A turn suspended on a permission at TTL time.** Busy ⇒ never `idle_ttl`
  and never evicted (load-bearing §): it waits for an answer however long.
  Only the admin cap / an explicit close archive it; its reload closes the turn
  as ended (no re-ask: the user ended it). Pinned by a test.
- **Disk full / write error while archiving.** The session is already
  unloaded, but its full record stays RESIDENT in the index entry until a write
  succeeds: listing and reopening work from memory, the error is reported once,
  every sweep retries. A daemon stopped in that state loses what the last
  successful write did not have (as any write failure today, reported).
  Memory: at most what the live sessions held.
- **A pending archive write vs reopen / delete.** Same per-id queue, call order
  wins (precondition): archive → reopen ⇒ the live record (no `archivedAt`)
  lands last; archive → delete ⇒ the file is gone. A late `written`
  confirmation finds its entry replaced or gone and does nothing.
- **Corrupt archived record.** At start: skipped, blocked, noticed, hidden
  (today, `serve.ts:135-151`). After start (damaged or removed by hand) → the
  reopen's load fails → entry dropped + blocked + reported → `UnknownSession`;
  the file is left as is.
- **Delete of a live / attached session.** Allowed (one principal, like
  close): attached clients get `turn_end{cancelled}` (if running) then
  `session_closed{deleted}`; the record is removed; a later open is
  `UnknownSession`, `open{create:true}` with that id is a fresh session.
  Delete during a reopen's load → the synchronous open finds no entry →
  `UnknownSession` (or a fresh session if `create`).
- **Two concurrent opens of one archived id.** One shared load; the first
  synchronous open restores, the second finds it live and attaches — one agent
  (the `open` invariant, `session-host.ts:144-150`).
- **Detached cap with every detached session busy** → `TooManySessions` as
  today; with an idle one → it is archived (its background jobs are killed,
  like at the TTL — jobs do not count as activity, `session-reaper.ts:4-6`).
- **Two daemons on one store.** Refused by the lock (precondition); unchanged.
- **Version skew.** Wire: v10 ↔ v11 → `VersionMismatch` at `initialize`. Disk:
  v1 records read as not archived; a v1 daemon refuses v2 records loudly,
  untouched.
- **Many archived records.** Start: streamed (peak one record); `list`: no disk,
  an O(N log N) in-memory sort per page (fine to ~10⁵; a sorted index is debt
  if ever needed).
- **Background jobs of an archived session** are killed (`jobs.dispose()`,
  `hosted-session.ts:992`); on reopen the agent has no jobs — the same as after
  a restart (noted, not new).

### Tests

Red first (shown failing on `main` + 2b): **A9′, L-cwd, S1**. Fakes: `SpyStore`
(+ `load`; it already has `hold` / `fail`) and `rig` in
`packages/daemon/test/persistence.test.ts:46-166`; serve tests in
`packages/cli/test/serve-persistence.test.ts` (A13 shape, `:80`).

Protocol (`packages/protocol/test/`):
- P1 `session/delete` params/result; `session_closed` accepts `deleted`; the
  version constant; fixtures + drift gate.

Pure:
- U1 `selectEvictable`: oldest idle detached; skips attached and busy (a
  suspended permission); all busy → `null`; ties by id.
- U2 `parseDaemonRecord`: v1 ok (no `archivedAt`), v2 ok, v2 with
  `archivedAt: 1.5 / -1` refused, v3 refused.
- U3 `reconcileOnReload` archived + resumable pending → NOT resumed, ended
  notes, turn end `cancelled`, steering kept; archived without `turn` → as is.
- **L-cwd** `toSessionList` per-entry `cwd` and `archived`; live + archived
  mixed order and keyset paging (no entry twice or skipped across pages).
- `JsonSessionStore.scan` yields every file once, unreadable ones included;
  the existing `list()` tests unchanged.

Host (`persistence.test.ts`):
- **A9′** (replaces A9) close and reaper close KEEP the record with
  `archivedAt`, `removed` stays empty, `list` shows `archived: true` with the
  record's `cwd`; nothing else written after. Red on main (`removed = [id]`).
- A20 reopen: `open{sessionId}` → full history, `created: false`,
  `resync: true`, new epoch; `create` / `messages` ignored; the next durable
  record has no `archivedAt`; `list` shows it live.
- A21 reopen from disk (fresh host, `addArchived`), through `Connection` over
  `createChannelPair`: two concurrent opens → one restore, both attached to the
  same session.
- A22 write held (`store.hold`): archive → reopen before the write lands →
  works from the resident record; `release()` → the final durable record is the
  live one.
- A23 `store.fail` on archive: reopen still works, one error, the sweep
  retries, clearing `fail` → it lands and the record leaves memory.
- A24 delete: live + attached → `turn_end{cancelled}` (if running) then
  `session_closed{deleted}`, record removed, gone from list, open →
  `UnknownSession`; archived with a held write → final durable absent; delete
  during a reopen's load (`store.load` held) → `UnknownSession`.
- A25 corrupt after start (`load` → unreadable) → `UnknownSession`, hidden,
  reported, `block`ed (never removed / written).
- A26 admin cap on a turn suspended on a permission (and the idle TTL skips it):
  reopen → no `permission_request`, turn closed `cancelled`.
- A27 detached cap 2 with 2 idle detached → create succeeds, the oldest is
  archived, audit line; both busy → `TooManySessions`; no persister →
  `TooManySessions`.
- A28 invariant: across create / archive / reopen / delete, no id is both live
  and archived.
- A29 no persister: close → not listed; delete live → `session_closed{deleted}`;
  delete unknown → no-op.

Serve (`serve-persistence.test.ts`):
- **S1** restart: archived records come back archived (not live, `host.size`
  excludes them), live ones live; `session/list` mixes them in order. Red on
  main (an archived file is restored live).
- S2 a v1 record (today's format) restores live after the upgrade.

Mutations (each applied, run, reverted — §9):

| # | Mutation | Must turn red |
|---|---|---|
| M1 | `SessionHost.close` → today's `persister.remove` | A9′, A20, S1 |
| M2 | `open` ignores `prepared` (uses `entry.record` only) | A22 / A21 |
| M3 | `reconcileOnReload` ignores `archivedAt` | U3, A26 |
| M4 | `selectEvictable` ignores `busy` | U1, A27 |
| M5 | `written.then` drops `entry.record` even on failure | A23 |
| M6 | `toSessionList` uses the host's `defaultCwd` for every entry | L-cwd, A9′ |
| M7 | `delete` skips `persister.remove` for a live id | A24 |
| M8 | `parseDaemonRecord` restores a v2 `archivedAt` record live (ignores the field) | S1 |

Validation: `bun run check` green (lint baseline clean, AGENTS §6); the Repro
re-run shows `on disk after close / reap: true true` and `list` with two
`archived: true` entries.

## Execution

*— claude-opus-5-5, 2026-10-24*

### Baseline (before any edit, `feat/session-archive` = `main` e4b536e + this doc)

`bun run check`: typecheck clean · lint `Checked 430 files … No fixes applied` ·
**2257 pass / 2 skip / 0 fail** (the two opt-in skips).

### Premises re-verified on today's code (post 4a–4d, 2b, version-mismatch-notice)

Every "Builds on" item still holds, at new lines:
`HostedSession.close()` aborts → `finishTurn(…cancelled)` → ends a waiting
send-now (`endUnstarted`) → `session_closed` → detach → `jobs.dispose()`
(`hosted-session.ts:1257-1283` before the edit); `persist()` is a no-op once
closed (`:530-534`); `persistedState()` (`:546-570`) is the only capture; busy =
`controller !== null` (`:573-575`), `liveness().busy = running` (`:600-608`);
`Connection.open` synchronous, one `host.open` (`connection.ts:293-311`),
`closeSession` = `attached.delete` + `host.close` (`:325-329`);
`PROTOCOL_VERSION` 10 (`version.ts:7`); `DAEMON_RECORD_VERSION` 1;
`toSessionList(summaries, cwd, params)` (`session-list.ts:65-97`); `serve` start
`store.list()` then `restore` (`serve.ts:160-194`); `ReapPolicy.idleTtlMs:
number | null`, `sweepIntervalFor` in `session-reaper.ts`; `InitializeParams`
untouched by this task (`git diff e4b536e -- packages/protocol/src/session.ts |
grep Initialize` → empty). Two facts the plan did not know, both handled below
(drift 2): a send-now successor is memory-only (`hosted-session.ts:239-240`) and
`close` writes its `turn_end{cancelled, delivered:false}` key only in memory;
the client's reconnect `open` is `{sessionId, since}` and an `UnknownSession`
there triggers `recreate` from the client's history (`remote-client.ts:963-1065`).

### Repro (on clean code, `.tentacle/tmp/session-archive/`)

`repro.ts` is the Context's script plus `sameProject` in the options and the
list printed as `[title, archived, cwd]`. Before:

```
$ bun run .tentacle/tmp/session-archive/repro.ts
on disk after open: true true
reaped: 1
on disk after close / reap: false false
list: []
```

After (Validation of the plan):

```
on disk after open: true true
reaped: 1
on disk after close / reap: true true
list: [["idle me",true,"/w"],["keep me",true,"/w"]]
```

Load-bearing assumption re-run on clean code (`reload.ts`, the Implementation's
snippet as a script): `same id: true | new object: true` · `history equal:
true (3 messages)` · `new epoch: true` · `listed: [["first",false]]`. Holds.

### As built (plan order)

1. `protocol/src/version.ts` — `PROTOCOL_VERSION` 10 → **11**.
2. `protocol/src/session.ts` — `session/open` doc rewritten (archived id: reload
   only with `reopen: true`, else `SessionArchived`; `UnknownSession` = not live,
   not archived); `OpenParamsSchema.reopen?: boolean` (new, see drift 1);
   `session/close` doc (archives on a persisting daemon, idempotent on archived);
   new `--- session/delete` section, `DeleteParamsSchema` / `DeleteResultSchema`;
   `SessionListEntry.cwd` / `.archived` docs.
3. `protocol/src/updates.ts` — `session_closed.reason: ["closed", "deleted"]` + doc.
   `protocol/src/jsonrpc.ts` — `DomainErrorCode.SessionArchived = -32014` (drift 1).
4. `protocol/src/methods.ts` — `Method.SessionDelete = "session/delete"`, `RequestSchemas`.
5. `protocol/schema/protocol.json` — `bun run schema:export`; fixtures in
   `json-schema.test.ts` (`session/delete` params/result, `open{reopen}`, both
   `session_closed` reasons); drift gate green.
6. `agent/src/session-store.ts` — `scan()` (async generator, one `load` at a
   time, sweeps temps, missing dir → nothing); `list()` rebuilt on it (same
   semantics, still sorted).
7. `daemon/src/persisted-session.ts` — `DAEMON_RECORD_VERSION = 2`,
   `READABLE_VERSIONS [1, 2]`; `archivedAt?` on state and record, spread by
   `toDaemonRecord`; `parseDaemonRecord` reads v1 as v2 (normalised, see
   nuances) and checks `archivedAt` with `isWireStamp`; `reconcileOnReload`
   never resumes an archived turn and closes it with `ENDED_NOT_RUN_NOTE` /
   `ENDED_INTERRUPTED_NOTE` / `ENDED_SUBAGENT_INTERRUPTED_NOTE` and
   `ARCHIVED_TURN_END = {stopReason: "cancelled"}`.
8. `daemon/src/session-persister.ts` — `RecordStore.load`;
   `PersisterOptions.sameProject?`; `archive(state, at) → {record, written}`;
   `writeRecord(record, report = true) → Promise<boolean>` (the one write path;
   `schedule` uses it); `load(id)` (flush first, then store + `parseDaemonRecord`);
   `persistable()` / `toRecord()` factored out of `schedule`; `report()` public.
9. `daemon/src/session-list.ts` — `SessionSummary.cwd` / `.archived`;
   `toSessionList(summaries, params)` (no shared `cwd`).
10. `daemon/src/session-reaper.ts` — `selectEvictable`; `Expired.archived?`;
    `startReaper` audits `session-archived` vs `session-reaped` per entry.
11. `daemon/src/hosted-session.ts` — `close(reason = "closed")`; `archive()`
    (drift 2); `summary(cwd)` gains `cwd`, `archived: false`.
12. `daemon/src/session-host.ts` — `ArchivedEntry` index + `loads` map;
    `list` (live + archived from memory); `archivedCount`; `prepareOpen`;
    `open(params, attachment, prepared?)`; `close` = `archive(id).closed`;
    `delete`; `addArchived`; private `archive` / `settleWrite` /
    `retryUnwritten`; `admit` evicts (Q1); `reapExpired` archives and retries;
    `restore` refuses an id that is live OR archived.
13. `daemon/src/connection.ts` — `open` is `async`: `await host.prepareOpen`
    FIRST, then the unchanged synchronous body; `case Method.SessionDelete`.
14. `daemon/src/index.ts` — nothing (already `export *`).
15. `client/src/remote-client.ts` — `deleteSession`, sharing `endSession` with
    `closeSession` (same guards / forget); `closeSession` doc.
16. `cli/src/serve.ts` — `sameProject` built once and given to the persister and
    the start loop; start iterates `store.scan()`: unreadable → block + notice,
    parse failure → block + notice, `archivedAt` → `addArchived`, else `restore`.
17. Docs: `daemon-side-persistence.md` status banner ("superseded in part: close
    archives, delete removes"); AGENTS §7 Persistence bullet gains the archive
    rule (rides this branch, AGENTS §10).

### Drift from the plan (and why)

1. **Reconnect never revives (owner's re-approval note) — daemon-side opt-in,
   not the planner's "live only" flag.** The plan said "an archived id is
   reloaded whatever `create` / `messages` say". That is exactly the revival
   bug: the client's reconnect sends `open{sessionId, since}` and, on
   `UnknownSession`, `recreate`s with `messages`. Chosen shape: the reload needs
   an explicit `reopen: true` (a person's "reopen"); any other open of an
   archived id → new `SessionArchived` (-32014), whatever `create`/`messages`
   say. Inverse default to the planner's suggestion, because every path that is
   not an explicit reopen — reconnect, the reducer's forced reopen, `recreate`,
   an `openSession(…, id)` with `create` — is then safe by default, and a new
   session can never be built over an archived record (it would have
   overwritten the file under the same id). The daemon decides; the client
   guesses nothing: `SessionArchived` is not `UnknownSession`, so the existing
   client code does not recreate — it fails the session with the daemon's
   message (`recovery failed: session S was ended and is archived: reopen it to
   resume it`). No client logic changed for this.
2. **The archive capture is `HostedSession.archive()` (close inside it), not
   `archiveState()` before `close()`.** History and `turn` (pending ask,
   steering) are taken before the close, as planned; the turn keys and stamps
   after it — so the ends the close streamed (`turn_end{cancelled}`, and a
   waiting send-now's `{cancelled, delivered:false}`, memory-only until then)
   are on disk, and a retried `prompt` / `send_now` after the reopen gets them
   instead of starting a duplicate turn.
3. **Third ended note** `ENDED_SUBAGENT_INTERRUPTED_NOTE` (a sub-agent's ask at
   the close), symmetric with the restart notes; the plan named two.
4. **`selectEvictable` returns the id; the audit is per entry** (`Expired.archived`):
   a session that could not be kept (a blocked / unsafe id) is still audited
   `session-reaped`, honestly.
5. **`load` lives on the persister and is only reached through `prepareOpen`
   with `reopen: true`.** A non-reopen open never touches the disk.

### Nuances decided (all of them)

- **v1 → v2 normalisation**: a v1 record parses as `schemaVersion: 2`; an
  `archivedAt` it might carry (impossible in practice) is dropped — v1 had no
  archive. Refusal text: `unsupported record version 3 (this daemon reads 1, 2)`.
  Every write is v2. A v1 file is rewritten v2 on its first write (S2).
- **`sameProject` is optional** on the persister (default: same string as
  `cwd`); `serve` passes the project-key comparison, so start and reopen use one
  rule. Kept optional to avoid churning five test persisters.
- **`RecordStore.load` is required**: four test fakes gained it.
- **Resident record lifecycle**: kept from the archive until its write is
  confirmed; a confirmation for an entry that was reopened / deleted / replaced
  meanwhile does nothing (`settleWrite` identity check).
- **Failed archive write**: reported once (at the archive); each reaper sweep
  retries quietly (`writeRecord(record, false)`), one in flight per entry.
  **Open item:** with `--session-ttl never` and no admin cap there is no sweep
  timer, so no retry until a sweep exists; the record stays resident and works,
  and a daemon stopped in that state loses it (reported) — as the plan's
  failure-mode text already accepted for a stop.
- **After `persister.stop()`** an archive is not written (`written` → false):
  the entry stays resident until the process ends.
- **Eviction (Q1)**: only with a persister; victim = idle detached with the
  smallest `lastActiveAt`, ties by id; audit `session-archived <id> evicted`.
  A victim whose id cannot be persisted (blocked file / unsafe name) is just
  closed — as the idle TTL does today. Refusal text: with a persister
  `… — every detached session is running a turn`; without one, the old text.
  `maxSessions` is unchanged (refuses; archived entries count toward nothing).
- **Reopen**: not admitted through the limits (an attach), `created: false`;
  `resync` comes from `attach(…, since)` — always true (new epoch).
- **Reopen load failure** (gone / unreadable / other project): entry dropped
  (hidden), id `block`ed, one error `archived session <id> could not be
  reopened: <reason> (left as is)`, the open answers `UnknownSession`.
  Concurrent reopens share one read (`loads` map).
- **`restore` / `addArchived`** throw `session <id> is already known` for an id
  already live or archived (the "one map at a time" invariant, A28).
- **Start order**: `scan()` is directory order (the old `list()` sorted by
  `updatedAt`); nothing depends on restore order (the list sorts, eviction uses
  `lastActiveAt`). `list()` still sorts.
- **Start notice**: `restored N session(s), M archived, from <dir>` — the
  `, M archived,` part only when M > 0; the line now also prints when only
  archived records exist (`restored 0 sessions, 3 archived, from …`).
- **`delete`**: live → `close("deleted")` then `persister.remove`; archived →
  index drop + `remove` (queued after a pending write in the store's per-id
  queue, A24b on the REAL store); unknown → `false` / `{}`.
- **Persisted TTL** (2b's note): NOT widened — owner Q3 says a runtime TTL change
  is not persisted; `persisted: z.literal(false)` unchanged.
- **Client**: `deleteSession` only; **no `reopenSession` API** (task 7 adds the
  UI and the call; `session/open{reopen: true}` is ready).
- **Task 5 seam (steer ids)**: NOT done — not a trivial optional field: it needs
  the constructor's resume path to restore `steeringIds` and the send-now
  refusal/`held` semantics to accept restored ids. Seam: an optional
  `turn.steeringIds` can ride v2 (a v2 daemon ignores an unknown field on read
  and drops it on its next rewrite — a degrade, never a half-load); task 5
  decides whether that degrade needs a 2→3 bump (task 3 bumps to 3 anyway).
- **Task 3 seam (titles)**: `ArchivedEntry.title` reads `record.title`; a rename
  of an archived session replaces the entry and writes the record.

### Existing tests changed (each a meaning this task changes)

`protocol/test/hooks.test.ts` pinned `PROTOCOL_VERSION === 10` → `>= 10`.
`persistence.test.ts` **A9 replaced by A9′**; record fixtures `schemaVersion`
1 → 2 (the current format; v1 is tested explicitly by U2/S2), "another version"
2 → 3. `session-list.test.ts`: helpers carry `cwd`/`archived` (new signature),
L7 hostile cwd per entry, **H3** "a closed session is not listed" → listed
archived (persisting host). `send-now.test.ts`: `summary(CWD)`.
`serve-limits.test.ts`: audit verb `session-reaped` → `session-archived` (all
13, so the negative checks stay meaningful); the TTL test now asserts
`SessionArchived` on a plain open and a successful `reopen`; **"the 17th is
refused while 16 are detached" rewritten** to Q1 (the 17th archives the oldest
of A's 16, nothing refused). `serve-persistence.test.ts`: A13 now checks the
file is kept stamped after close and removed by `session/delete`; A11's
"newer" is v3. `reattach.test.ts` `MemStore.load`.

### New tests

P1 (`protocol/test/session-archive.test.ts`: delete schemas, both reasons,
`reopen`, `SessionArchived`, version 11, a v11 `initialize` still parses) ·
`scan` ×2 · U1 · U2 · U3 · L-cwd · A9′ · A20 · A21 (over `Connection`, two
concurrent reopens) · A22 · A23 · A24 / A24b (real store) / A24c · A25 · A26 ·
A27 · A28 · A29 · S1 · S2 · **DECISIVE** reconnect test and `deleteSession`
(`client/test/reattach.test.ts`) · version 10↔11 ×2
(`daemon/test/version-mismatch.test.ts`).

### Red before green

- P1: 4 of 5 red on the assertions before the schema edits (the version case
  shown red by putting `PROTOCOL_VERSION` back to 10 for that run).
- `scan` ×2: red (no method) before `scan()`.
- U2 / U3: red on the ASSERTIONS (the note constants were exported first, so
  the file loaded), then green.
- A9′: red on main code (`removed` = `[id]`), then green.
- U1: red (`selectEvictable` absent → `undefined`), then green.
- L-cwd: red on main, but on a `TypeError` (the old 3-argument signature), not
  on the property — its non-vacuity is M6 below.
- S1: written after the serve change, so not shown red first — non-vacuity by
  M8 and M1. A20–A29, S2, the client tests and the 10↔11 tests were written
  with the implementation; non-vacuity by the mutations below.
- **Found while mutating**: `client/test/support/fakes.ts` `until` RETURNS
  `false` on timeout (never throws). My first `deleteSession` test stayed green
  under M7 because of it; both new client tests now `expect(await until(…))
  .toBe(true)`. Existing `reattach.test.ts` tests may use `until` the same way —
  not audited (out of scope; worth a look by the reviewer).

### Mutations (AGENTS §9) — applied, run, reverted

| # | Mutation | Turned red |
|---|---|---|
| M1 | `SessionHost.archive` → close + `persister.remove` (today's close) | A9′, A20, S1, A13, A21–A28 (13) |
| M2 | `open` ignores `prepared` (resident record only) | A20, A21, A23, A26, S1 |
| M3 | `reconcileOnReload`: `ended = false` (ignores `archivedAt`) | U3, A26 |
| M4 | `selectEvictable` ignores `busy` | U1, A27 |
| M5 | `settleWrite` drops the resident record even on failure | A23 |
| M6 | `toSessionList` one constant cwd for every entry | L-cwd, A9′ |
| M7 | `delete` skips `persister.remove` for a live id | A24, client `deleteSession` (after the `until` fix) |
| M8 | `parseDaemonRecord` strips `archivedAt` from v2 too | S1, A9′, U2, A21, A23, A26 |
| M9 | an archived id reloads without `reopen` (the plan's original rule) | **DECISIVE**, A20, S1, serve-limits TTL test |
| M10 | `PROTOCOL_VERSION` back to 10 | version 10↔11 test (and P1) |

After each revert the mutated file's `shasum` equals the pre-mutation one
(`session-host.ts 2962eca0…`, `persisted-session.ts 2e166cd7…`,
`session-reaper.ts 3d276b2e…`, `session-list.ts 72447c88…`, `version.ts
9dbb991f…`). Not covered by a named mutation: A24b, A24c, A25, A28, A29, S2
(each asserts its own boundary; a reviewer may want one mutation each).

### Version skew (version-mismatch-notice constraint)

`InitializeParams` is untouched (diff above), so a v10 daemon still parses a v11
client's `initialize` and words the refusal. Pinned: the real v11 `Connection`
answers a 0.1.0 client's frame with exactly `protocol version mismatch: client
10 (tentacle 0.1.0), daemon 11 (tentacle 0.2.0) — update this client:
"tentacle update"` + its `data`; the v11 frame parses under
`InitializeParamsSchema`, and `versionMismatch` (unchanged since v10) words the
other direction `update: "daemon"`. **Unverified by execution here:** a real v10
daemon binary against a v11 client — the v10 daemon is today's `main`, and that
exact pairing was run end to end by version-mismatch-notice (its Execution,
"a v11 client with clientInfo against today's v10 daemon").

### Gate (end)

`bun run check`: typecheck clean · lint `Checked 431 files … No fixes applied`
(clean, = baseline) · **2286 pass / 2 skip / 0 fail** (baseline 2257 / 2 / 0;
+29 new tests, the same two opt-in skips).

### Open items for the owner

1. **A delete on device B, then device A reconnects**: the daemon answers
   `UnknownSession`, and A's client `recreate`s the session from its own copy —
   a deleted session comes back on A's reconnect. Not the archived case the
   owner fixed (that one is `SessionArchived` now), but the same family; the
   daemon keeps no tombstone. Task 7 (or a tombstone here) should decide.
2. Failed archive writes are retried only by reaper sweeps (none with
   `--session-ttl never` and no admin cap).
3. Task 5's steer ids: seam only (above).

### Follow-up 1 (Review round 1)

*— claude-opus-5-5, 2026-10-24.* Implements the "Owner decisions after Review
round 1" (F1, F2), plus F4 and N1. F3 / F5 untouched (accepted debt).

**F1: a durable tombstone, and `SessionDeleted`.**
- Protocol: `DomainErrorCode.SessionDeleted = -32015` (`protocol/src/jsonrpc.ts`),
  additive, no `PROTOCOL_VERSION` change (an older client treats it as a plain
  failure and does not recreate, because it is not `UnknownSession`).
  `session/open` and `session/delete` docs updated (`protocol/src/session.ts`);
  `protocol.json` regenerated (`bun run schema:export`; the only new line is
  `"SessionDeleted": -32015`); drift gate green.
- **Where the tombstones live (decided): a separate file in the record dir,
  `<configDir>/daemon/<projectKey>/deleted-sessions`, one id per line,
  appended and fsynced** (`daemon/src/session-tombstones.ts`, `TombstoneFile`).
  Not in the records: a tombstone record would be a `.json` that an older
  daemon (and today's scan) reads as an unreadable record, blocks, and reports
  at every start. Not in a rewritten index: an append is one fsync, with no
  temp+rename. A file without `.json` is skipped by `scan()` and by the temp
  sweep, and an older daemon ignores it. A torn last line (a crash mid-append)
  has no newline and is dropped on load.
- Order (`SessionPersister.remove`): the tombstone is written FIRST, then the
  file is removed, so a crash cannot leave the id with neither. If the
  tombstone write fails, the failure is reported and the file is removed
  anyway (the user asked for it). `remove(id, false)` only finishes a removal.
- Host (`daemon/src/session-host.ts`): a `deleted` set (an id is live,
  archived, OR deleted, never two: `known()`). `delete` tombstones the id only
  if the daemon had it, live or archived. A delete of an unknown id still
  tombstones nothing, so it cannot poison an id. `open` of a tombstoned id →
  `SessionDeleted`, whatever `create` / `messages` / `reopen` say.
  `addDeleted` / `isDeleted` serve the start. Without a persister (a pod
  daemon, the worker) the tombstone is in memory only, which still stops a
  reconnect within that daemon's life.
- `serve` start (`cli/src/serve.ts`): it loads the tombstones before the scan.
  A record found beside its tombstone (a delete cut short between the two
  writes) is not restored, and its removal is finished. That is not an
  automatic purge: the user asked for that delete. An unreadable tombstone
  file → one start notice, and the start goes on.
- Client (`client/src/remote-client.ts`): `onSessionDeleted(listener)`.
  `noteDeleted` fires it on the CODE only (`RpcError.code ===
  SessionDeleted`), from `openOn` (reconnect, `--resume`) and from
  `recreate` (a delete that raced the recreate). The open still fails. It
  never recreates (the recreate branch is `UnknownSession` only).
- CLI (`cli/src/local-runtime.ts`): on that notice, `saver.remove(id)` and the
  in-TUI notice (`deps.notify`, the `NoticeHub`; never a raw write): "⚠ This
  session was deleted from another device: it was not restored, and its local
  copy was removed." `SessionSaver.remove` (`cli/src/session-saver.ts`) is
  queued after a save in flight (the store's per-uid queue). A later save of
  the id is dropped, and a save in flight that fails after it is not reported.
  `SaveTarget` gains `remove`, so four test fakes gained `remove: async () => {}`.

**F2: a reopen counts against `maxSessions`.** In `open`'s archived branch,
`admitLive()` (the `maxSessions` half of `admit`, factored out) runs BEFORE the
entry leaves the archive. A refusal is the existing `TooManySessions` with `data
{limit: "sessions", max}` and the same audit line. The record stays archived
and its bytes are unchanged (nothing is written), and nothing is evicted. The
detached cap is not applied, because a reopen is attached at once.

**F4.** `until` (`client/test/support/fakes.ts`) now THROWS on a timeout and
returns `Promise<true>`. A non-throwing `poll` exists only for callers that
branch on the result: the e2e harness (`reattach.e2e.test.ts`) turns a
timeout into a recorded mismatch. Its `until(() => false, 2000)` race timer is
now `Bun.sleep(2000)`. **Tests that failed with the throwing `until`: none.**
The whole client suite ran green (240 pass), and so did the full gate. So no
ignored `until` times out in a correct run, and no test needed fixing. The
reviewer's candidate (`reattach.test.ts` "finding 4: closeSession during a
recovery…", `:783`) was checked by mutation. The test was mutated so that
`closed` is never set (`onFrame` matches `session/openX`). It is RED with the
throwing `until` (`until: timed out … closed !== null`). It is ALSO red with the
old, non-throwing wait (`poll`): the client then recreates S on the new host, so
`host.get("S")` is not `undefined`. So the candidate was not vacuous: the
reviewer's "`undefined` on the fresh host anyway" did not hold. Both edits were
reverted.

**N1.** The `recreate` doc (`remote-client.ts`) now says that only a daemon that
persists nothing loses a session. A `serve` daemon answers `SessionArchived` /
`SessionDeleted` and the client never recreates.

**Existing tests changed (meaning changed by F1):** `persistence.test.ts` A24:
after a delete, open → `SessionDeleted` (it was `UnknownSession`), for plain,
`reopen`, `create` and `messages`. The old "a fresh session under that id is a
new one" is inverted: the id is never reused. An unknown id is still creatable
after a no-op delete. A24c: the reopen racing a delete → `SessionDeleted`.

**New tests (9):** serve F1 ×2 (`serve-persistence.test.ts`: the Review's repro
across a real restart; a record left beside its tombstone) · F2
(`persistence.test.ts`) · persister order tombstone→remove · `TombstoneFile` ·
client F1 (`reattach.test.ts`) · local-runtime F1 (`local-runtime.test.ts`) ·
`SessionSaver.remove` (`session-saver.test.ts`) · protocol F1 (code pinned,
codes unique).

**Red before green:**
- serve F1 (repro): RED, `Expected: -32015, Received: -32003`. Record left
  beside its tombstone: RED, `restored` notice `Expected: false, Received:
  true`. F2: RED, no throw (`Received: undefined` vs `[TooManySessions,
  {limit, max}]`). local-runtime F1: RED on the notices (`[]`).
- Client F1: red first only on a `TypeError` (no `onSessionDeleted` yet), not on
  the property. Its non-vacuity comes from M-F1a and M-F1b. The persister-order,
  `TombstoneFile`, saver and protocol tests were written with the code, so they
  were not shown red first. Their non-vacuity comes from the mutations.
- Found by the saver test, not planned: a save in flight that FAILS after
  `remove` reported "not saved". Fixed with the guard in `settle`.

**Mutations (applied, run, reverted; `shasum -c` OK on `session-host.ts`,
`remote-client.ts`, `serve.ts`, `session-persister.ts`; the saver hash matched
after its own):**

| # | Mutation | Turned red |
|---|---|---|
| M-F1a | `open` ignores the tombstone | serve F1 ×2, A24, A24c, client F1 |
| M-F1b | `noteDeleted` never fires | client F1 (`until(deleted)` false) |
| M-F1c | `serve` loads no tombstones | serve F1 ×2 |
| M-F1d | file removed in parallel with the tombstone write | persister order |
| M-F1e | `TombstoneFile.load` keeps the torn tail | `TombstoneFile` |
| M-S1 | `SessionSaver.save` ignores `removed` | saver remove |
| M-S2 | `settle` ignores `removed` | saver remove |

**Repro note:** `review-e2e.ts` builds its "restarted" host by hand, without
`serve`'s start, so it cannot see a durable tombstone. The serve F1 test is that
repro through the real `startDaemon` and disk, and it is the red→green evidence.

**Gate:** `bun run check`: typecheck clean · lint `Checked 432 files … No fixes
applied` (clean; the only trip was formatting, fixed with `biome check
--write`) · **2295 pass / 2 skip / 0 fail**, `Ran 2297 tests across 183 files`
(round 1: 2286 / 2 / 0; +9 new; the same two opt-in skips).

**Debt / not done:** (1) The tombstone file only grows: one line (~40 B) per
deleted session, never compacted. (2) A client ATTACHED when the delete
happens gets `session_closed{deleted}` live and keeps its local copy until its
next open of that id. That open answers `SessionDeleted`, which removes the copy
(this converges, but later). The live update's handling is task 7's. (3) A
tombstone write that fails is reported, and the file is still removed. After a
restart that id is then unknown again, so an offline client could recreate it.
The failure is loud, not silent. (4) N2–N4 are unchanged.

### Follow-up 2 (Review round 2)

*— claude-sonnet-5-5, 2026-10-24.* Only R2-1…R2-6 and the owner decision on
R2-4; nothing else touched. No commit.

- **R2-1** `session-tombstones.ts` `add`: appends `\n${id}\n` (a torn tail ends
  as a line of its own); `load` skips blank lines. Test (persistence.test.ts,
  the reviewer's repro as `TombstoneFile`): torn tail → `add` → `load` contains
  both ids. **Red on the old code** (`Received: [..0001, "a1b2c3d4-0000-40ffffffff-…0002"]`), green after.
  Side effect: a torn fragment that happens to be a valid id becomes a
  harmless extra tombstone.
- **R2-2** test only (`reattach.test.ts`): a fresh host answers the
  reconnect `UnknownSession`, then `addDeleted("S")` right after, so the
  recreate gets `SessionDeleted`. Passes on the code (it was correct, only
  unpinned). **Mutation M1** (`noteDeleted` removed from `recreate`'s catch):
  red (timed out, listener never fires); reverted, green.
- **R2-3** `load(onGarbled?)` hands each non-blank invalid terminated line to
  the callback; `serve.ts` turns it into a start notice (the `onNotice` path,
  as the other start notices). Tests: unit (persistence.test.ts) and e2e
  (serve-persistence.test.ts, the valid line still holds). Red before, green after.
- **R2-4** `serve.ts`: an unreadable `deleted-sessions` throws from
  `reloadedHost` ("can't start: couldn't read <path>: <cause> …"); `startDaemon`'s
  catch already releases the lock and `main.ts` prints it. Missing file: fine.
  Test (serve-persistence.test.ts): the path is a directory (EISDIR); the error
  names path and cause; after removing it the next start works (lock released).
  Red on the old code (it only warned).
- **R2-5** `session-persister.ts` `remove`: tombstone first even when the id
  is `blocked`; a blocked id's file is still left as is. Test: blocked id →
  `tombstones.add` called. Red before, green after.
- **R2-6** `add` fsyncs the directory when it created the file (best effort,
  errors swallowed: not every OS can open a directory). No test: durability of
  a first creation is not observable without a crash.
- **Mutations:** only M1 was applied as a separate step. For R2-1/3/4/5 the
  "mutation" is the old code, which the red run above already was.
- **Gate:** `bun run check`: typecheck clean · lint clean (one formatting fix
  by `biome --write` on my own test) · **2301 pass / 2 skip / 0 fail**, 2303
  tests, 183 files (Follow-up 1: 2295; +6 = my 6 tests; same two opt-in skips).

## Review

> **Orchestrator note (2026-10-24) — owner re-approved this split 2a plan, with one addition:** a reconnect re-open must NOT revive an archived session (found by the task 7 planner, `connect-sessions.md` O1). Decisive test: drop client A's link, client B closes (archives) the session, A reconnects → `session/list` still shows it archived and A gets a clear "session ended" outcome, not a silently revived live session. Planner's recommendation: the client's reconnect `open` carries an additive "live only" flag so `prepareOpen` skips the archive; the executor verifies against the code and may choose a cleaner daemon-side shape (owner principle: the daemon decides, the client never guesses). The owner acknowledged the `PROTOCOL_VERSION` 10→11 bump: a 0.1.0 client fails `initialize` with `VersionMismatch` against a new `serve` (clean, not mid-session). Re-verify every premise against main after 4c/4d (send_now, `held`, continuation turns) before editing.

> **Orchestrator note (2026-10-24) — constraint from `version-mismatch-notice` (merged before 2a):** when bumping `PROTOCOL_VERSION` to 11, `initialize` params must stay readable by EVERY daemon (old and new): never make a field required or change a type there, or an older daemon answers `InvalidParams` and the user loses the version-mismatch message. The daemon's `VersionMismatch` refusal (with `data`, the owner-approved wording) must be what a 10↔11 pair sees — add a test for both directions.

*— claude-opus-5-5 (fresh context, adversarial reviewer), 2026-10-24.* Same
model as the executor (only a fresh context): shared blind spots survive both
passes; for a load-bearing task a second review by a different model is
advisable (AGENTS §10).

### Verdict: **APPROVE-WITH-NITS** — conditional on an owner decision on F1 (and F2) before merge

What the task promised holds and is pinned by non-vacuous tests. The two
medium findings are gaps next to it (F1 the same family as the owner's
"never revive" addition), not regressions of anything that works today: no UI
calls `session/delete` yet, and F2 is a choice the approved plan made. The owner
decides: fix them here, or defer them to task 7 with a `TODO.md` entry.

### Findings

1. **F1 — Medium, real bug (open item 1): a deleted session is revived by an
   offline client's reconnect.** `SessionHost.delete` keeps no trace of the id
   (`packages/daemon/src/session-host.ts:358-372`). The reconnect then gets
   `UnknownSession`, and the client `recreate`s on that code
   (`packages/client/src/remote-client.ts:1026-1029`, `:1055-1064`) from its own
   history, under the same id. Trace (`review-e2e.ts`, below):
   `reconnect after delete: err -32003` → `client recreate after delete: ok
   created=true` → `listed: [["S",false]]`. The session is live again and written
   to disk. This breaks decisions 4/5 ("Delete removes it"; every client
   converges) and the owner's principle: the daemon KNOWS the session was
   deleted, but it tells the client nothing, so the client guesses "lost by a
   restart". The fix is cheap and additive, because a new error code needs no
   version bump (an older client treats it as a plain failure and does not
   recreate): a daemon-side tombstone answers `SessionDeleted`, and the client
   does not recreate on it. If it is deferred, task 7 must not ship "Delete"
   without it.
2. **F2 — Medium, owner decision: a reopen bypasses `--max-sessions`.**
   `open`'s archived branch goes through `restore` with no `admit`
   (`session-host.ts:310-329`). This is the plan's own choice ("not admitted
   through the limits, an attach"). But a reopen BUILDS a live agent from disk;
   it is not an attach to a live one. Trace: `maxSessions: 1` and 1 live session
   → the reopen succeeds and there are 2 live sessions. One authenticated client
   can therefore reopen every archived record at once (memory: the Context
   measured 1 GB for 1000 records). That breaks the plan's own bound, "live
   sessions (bounded by `maxSessions`)" (§serve start). Suggest:
   `maxSessions` applies to a reopen (`TooManySessions`); the detached cap may
   stay as is.
3. **F3 — Low (open item 2, worse than stated).** A failed archive write is
   retried only by a sweep. No sweep runs with `--session-ttl never` and no
   admin cap. The executor's text misses one consequence: the file left on disk
   is the previous LIVE record (no `archivedAt`). So after a restart the ended
   session comes back LIVE, and if it was closed while suspended on a
   permission, that permission is ASKED AGAIN (`reconcileOnReload` resumes it,
   because it is not stamped). The failure is reported (`onError`), so it is
   not silent. Suggest one retry in `persister.stop()`, or on the next write of
   any session.
4. **F4 — Low, pre-existing (open item 4).** `until`
   (`packages/client/test/support/fakes.ts:91-98`) returns `false` on a
   timeout. About 30 calls in `reattach.test.ts` ignore the result. Most are
   preconditions followed by assertions that would fail anyway. One candidate
   could pass vacuously: `reattach.test.ts:783-787`. If `closed` is never set,
   `await closed` is `await null`, and `host.get("S")` is `undefined` on the
   fresh host anyway. I did not mutate it; it predates this task. The two new
   client tests assert `until`'s result. Fix separately: make `until` throw.
5. **F5 — Low (open item 3).** Steer ids are not persisted, only the hook is
   left. Acceptable: task 5's scope, the seam is documented, nothing
   half-loads.
6. **N1 — Nit.** Stale comment at `remote-client.ts:1050`: "a close or reap
   while we were away". On `serve` those now answer `SessionArchived` and never
   recreate.
7. **N2 — Nit.** `SessionArchived` reaches the client as a generic `recovery
   failed: …` through `onError`. The client branches by code (no text
   matching): it does not recreate because the code is not `UnknownSession`.
   A dedicated "session ended" state is task 7's.
8. **N3 — Nit.** The v11→v10 direction is proven statically, not run: the test
   (`daemon/test/version-mismatch.test.ts`, the "11 → a v10 daemon" case)
   parses with TODAY's `InitializeParamsSchema`, which equals v10's only
   because the diff does not touch it (`git diff e4b536e --
   packages/protocol/src/session.ts` has no `Initialize` hunk; I verified).
   No run against a real v10 binary.
9. **N4 — Nit (document it).** Since every write is v2, a downgrade to a v1
   daemon refuses EVERY record, live ones too, not only archived ones. This is
   loud and the files are left untouched (main
   `persisted-session.ts:155` `!== 1`, then `block` + notice), as §7 requires.
   But a downgrade hides all sessions until the upgrade. The bump was
   necessary: without it a v1 daemon would restore every archived record live.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean · lint `Checked 431 files … No fixes applied`
(= baseline, clean) · **2286 pass / 2 skip / 0 fail**, `Ran 2288 tests across
183 files`. That matches the Execution; the two skips are the opt-in ones.

### Mutations (the reviewer's, on the gaps of open item 5 + the DECISIVE test)

| # | Mutation (temporary) | Turned red |
|---|---|---|
| R1 | `params.reopen !== true` → `false` in `prepareOpen` + `open` (always reload) | **DECISIVE**, A20, S1, serve-limits TTL test |
| R2 | archived `delete` skips `persister.remove` | A24b, A24c, A13 |
| R3 | failed reopen load keeps the entry | A25 |
| R4 | `archive` leaves the session in the live map (persister path) | A28 |
| R5 | `delete` without persister emits `closed` | A29 |
| R6 | `READABLE_VERSIONS = [2]` (v1 refused) | S2, U2, B7 |

Every one turned red. After each revert, `shasum` matched
(`session-host.ts 2962eca0…`, `persisted-session.ts 2e166cd7…`), and at the
end `git status --short` plus the `shasum` of every modified and new file were
byte-identical to the pre-review snapshot (`TREE-IDENTICAL`).

### Premise table

| Premise (cited) | Verdict |
|---|---|
| Context symptom: main's `close` removes the record (`session-host.ts` main `:227` `persister?.remove`) | TRUE (static check on e4b536e; the executor's run on clean code printed `false false`) |
| main `list` always `archived: false` (`session-list.ts` main `:85`) | TRUE |
| main refuses rather than evicts ("nothing is evicted", main `:265`) | TRUE |
| `session_closed.reason` was `["closed"]` (main `updates.ts:136`); the class is `mandatory` (`updates.ts:191`) → a bump is needed | TRUE |
| A v1 daemon refuses `schemaVersion !== 1` and blocks the file (main `persisted-session.ts:155`, `serve.ts:173`) | TRUE |
| main `serve` start uses `store.list()` (all in memory, main `serve.ts:160`) | TRUE; now `scan()` |
| The worker has no persister (`cli/src/worker.ts`: no match) | TRUE |
| The client recreates on `UnknownSession` only (`remote-client.ts:1026-1029`) | TRUE: this is why `SessionArchived` is safe, and why F1 is not |
| Live sessions are bounded by `maxSessions` (plan §serve start) | **FALSE** after a reopen (F2) |

### Attacks tried

1. **The reconnect revives an archived session** (owner's addition). This
   holds. The trace `reconnect open{sessionId,since}` and `recreate
   open{messages,create}` both answer `-32014`. R1 shows the DECISIVE test is
   non-vacuous.
2. **The reconnect revives a DELETED session.** It succeeds → **F1**.
3. **Bypass the limits by reopening.** It succeeds → **F2**.
4. **Half-load / version skew on disk.** A v2 record is refused by v1 (loud,
   untouched); v1 reads as v2 and is not archived (R6); a bad `archivedAt` is
   refused (U2). This holds (N4 is a consequence, not a defect).
5. **Races.** Delete during a reopen's load → `UnknownSession` (A24c, R2).
   Archive write in flight, then delete, on the real store → the file is gone
   (A24b). A late `settleWrite` checks the entry's identity. Concurrent
   reopens share one `loads` promise, and `load` never rejects (it catches), so
   the map cannot hold a rejected promise. This holds.
6. **A failed write, then a restart** → **F3**.
7. **§7 Don't serialize the RPC peer.** `Connection.open` awaits only
   `prepareOpen` (a per-id shared promise, no cross-request lock), then the
   synchronous body re-checks live/archived. This holds.
   **Single session path:** no new loop; a reopen is `restore`, the restart
   path. This holds. **No raw terminal writes:** the `serve` start notice still
   goes through `onNotice`, before listen. This holds. **Pod/worker persist
   nothing:** `--stdio` and the worker are untouched; A29 + R5 hold.
8. **Halves of the two-part run.** I found no half-done edit and no duplicated
   logic: one write path (`writeRecord`), one teardown (`archive`), and one
   `sameProject` built in `serve` and shared. The diff has no TODO/FIXME.

**End-to-end trace** (`.tentacle/tmp/session-archive/review-e2e.ts`, real
`JsonSessionStore`, a `serve`-style `scan()` restart):

```
on disk: schemaVersion 2 archivedAt? number
after restart: live 0 archived 1 [["S",true]]
reconnect open{sessionId,since}: err -32014 session S was ended and is archived: reopen it to resume it
recreate open{messages,create}: err -32014 session S was ended and is archived: reopen it to resume it
reopen (maxSessions=1, 1 live): ok created=false resync=true msgs=1 | live now 2
after delete: file exists false
reconnect after delete: err -32003 unknown session: S
client recreate after delete: ok created=true resync=false msgs=1
listed: [["S",false]]
```

### What holds

`PROTOCOL_VERSION` 10→11 is honest: `close` and `open` change meaning, and
`session_closed.reason` gains `deleted` in a `mandatory` update. `initialize`
is untouched. The 10↔11 refusal is worded in both directions (N3). The
`SessionArchived` (-32014) error is wired on both ends: the daemon throws it,
the client branches by code. `protocol.json` was regenerated and the drift gate
passes. `DAEMON_RECORD_VERSION` 1→2 was needed and is done right. The memory
index is metadata only; the record stays resident only until its write is
confirmed. Nothing is purged automatically: only `session/delete` calls
`remove`. A reconnect, a forced reopen or a `recreate` never revives an
archived session: `reopen: true` is the only way back, and R1 proves it.

### How the executor behaved

Well. Its drift was justified and written down: it chose daemon-side `reopen`
(a safe default) over the planner's flag, which matches the owner's principle
better. It surfaced its own open points honestly (F1, F3, F5) and found the
`until` trap (F4) itself. It disclosed which tests were not red-first (S1,
L-cwd on a `TypeError`) and left gaps for the reviewer, which my mutations
closed. It missed F2: it implemented the plan's "not admitted" without checking
it against the plan's own memory bound. It understated F3's consequence (a
restart revives the session, and a permission is re-asked).

### Owner decisions after Review round 1

- **F1 (deleted session revived by an offline client) — fix it, 2026-10-24.**
  The daemon keeps a durable tombstone of every id removed by
  `session/delete` and answers an open/reattach of that id with a new
  error `SessionDeleted` (additive, no `PROTOCOL_VERSION` bump). On that
  code — never on text — the client does not recreate the session,
  deletes its own local copy too, and the TUI shows "this session was
  deleted from another device". The client never guesses: the daemon
  reports the fact. *— recorded by the orchestrator (claude-opus-5-5) on
  the owner's "ok"*
- **F2 (reopen bypasses `--max-sessions`) — reopen counts against the cap,
  2026-10-24.** `session/open{reopen}` of an archived session is admitted
  like a new session: when the live cap is full it is refused with the
  existing `TooManySessions` error (same `data {limit, max}`), the record
  stays archived and untouched, and nothing is evicted automatically.
  Rejected alternative: archive the oldest idle session to make room
  (it would close something the user did not ask to close). *— recorded
  by the orchestrator (claude-opus-5-5) on the owner's "ok"*
- **F3 (failed archive write leaves the LIVE record on disk), F5 (steer
  ids)** — accepted as debt for this task: F3 is surfaced, not silent;
  F5 belongs to task 5.

### Review round 2

*— claude-opus-5-5 (fresh context, adversarial reviewer), 2026-10-24.* This is
the same model as the executor and the round-1 reviewer. Only the context is
fresh, so blind spots they share can survive all three passes. This task is
load-bearing, so a review by a different model is still advisable (AGENTS §10).

#### Verdict: **REQUEST-CHANGES** (one small fix in `TombstoneFile.add` + one missing test)

Follow-up 1 does what the owner decided for F1 and F2, and it breaks nothing
that held in round 1. The gate is green and the counts match the Execution. One
defect remains, and it is the kind the owner principle forbids: after a crash, a
later delete can lose its tombstone without any notice (R2-1). The fix is one
line plus its test.

#### Findings

1. **R2-1 — Medium: a torn tail swallows the NEXT tombstone, with no notice.**
   `packages/daemon/src/session-tombstones.ts:58` appends `${id}\n` to whatever
   the file ends with. Suppose a crash interrupts an append, leaving an
   unterminated tail. The next `add` glues its id onto that tail. The result is
   one line, `<torn><id>`, which `SAFE_ID` accepts, because two UUID fragments
   joined together are still a valid id. So `load()` returns that hybrid line,
   and the newly deleted id is NOT tombstoned. `persister.remove` then deletes
   the file. After the next restart the id is unknown again, and an offline
   client's `recreate` revives it. That is exactly round-1 F1, and this time
   nothing is reported.
   Repro (`.tentacle/tmp/session-archive/r2-torn.ts`, the real `TombstoneFile`):
   ```
   after crash, load: [ "a1b2c3d4-0000-4000-8000-000000000001" ]
   file: "a1b2…0001\na1b2c3d4-0000-40ffffffff-0000-4000-8000-000000000002\n"
   load: [ "a1b2…0001", "a1b2c3d4-0000-40ffffffff-0000-4000-8000-000000000002" ]
   second delete tombstoned? false
   ```
   The doc's claim ("a torn last line … is dropped on load") holds only until
   the next append. Fix: write `\n${id}\n` (or add a leading newline whenever
   the file does not end in one) and skip empty lines on load. A torn fragment
   then stays a harmless line of its own. Add a test: a torn tail, then `add`,
   then `load` contains the new id.
2. **R2-2 — Low: the recreate path's `SessionDeleted` is unpinned.** If you
   mutate `remote-client.ts:1105` (the `noteDeleted` in `recreate`'s catch) so
   it never fires, every test stays green: `packages/client` +
   `local-runtime.test.ts` gave 257 pass / 0 fail. The client F1 test covers
   only the `openOn` site. Add a client test where the delete lands between
   the reconnect's `UnknownSession` and the recreate.
3. **R2-3 — Low: a garbled line is dropped silently.**
   `session-tombstones.ts:48` filters out invalid lines without counting them,
   so nothing at start says "N lines unreadable". A corrupt line is a lost
   tombstone, so it should produce one start notice, the same way an
   unreadable file already does (`serve.ts`). Fail-loud, as AGENTS §7 and the
   brief require.
4. **R2-4 — Low (owner decision): an unreadable tombstone file does not stop
   the start.** It produces one notice ("may be recreated by a client"), and
   then the start restores the records that cut-short deletes left behind. The
   failure is loud but not fail-closed. The current behaviour is defensible;
   the owner should confirm it rather than inherit it.
5. **R2-5 — Nit: a blocked id is deleted without a durable tombstone.**
   `session-persister.ts:233` returns before the tombstone when the id is
   `blocked`. Here is how it happens: an unreadable `X.json` at start blocks X,
   then `open{X, create}` builds a live X (the host does not refuse blocked
   ids), then `delete(X)` writes an in-memory tombstone only, and no report is
   made. After a restart X is unknown again. This is an edge case, but it is
   silent. Suggestion: tombstone first, whether or not the id is blocked.
6. **R2-6 — Nit:** the tombstone file's first creation does not fsync the
   directory, so the very first tombstone is not strictly durable on every
   filesystem. The record writes have the same property, so this is
   consistent with them.

#### Owner decisions — implemented exactly?

- **F1**: yes. The daemon decides by code: `open` checks `deleted` first, for
  every combination of params (`session-host.ts:307`). The client branches on
  `RpcError.code` only (`remote-client.ts` `noteDeleted`) and never recreates
  on `SessionDeleted`. The CLI removes the local copy through `SessionSaver`
  and shows the notice through `deps.notify`, which is the `NoticeHub` (it
  buffers before Ink mounts, so there is no raw write). The tombstone is
  written before the removal (`session-persister.ts:236-240`). A record found
  beside its tombstone is not restored, and its removal is finished. Pod
  daemons and the worker get no `tombstones` (only `startDaemon` passes
  them), so their tombstones live in memory only. The code is additive and
  needs no bump, and that is honest: v11 has not shipped yet, a v10 client
  fails at `initialize`, and a branch-internal client would treat -32015 as a
  plain failure, which is not `UnknownSession`, so it would not recreate.
  Concurrency: there is one `TombstoneFile` per store (the store lock), and
  its appends are serialized by `tail`. A hostile id is refused on `add` and
  filtered out on `load`. The one gap is R2-1.
- **F2**: yes. `admitLive()` runs before `archived.delete`
  (`session-host.ts:333-335`). The refusal carries the same `data` and the
  same audit line. The record's bytes and the save count are unchanged, and
  nothing is evicted. The detached cap is unchanged (`admit` = `admitLive` +
  the same detached block).
- **F4**: `until` now throws (`fakes.ts:95-100`), and `poll` is used only by
  the e2e harness, which branches on its result. I did not repeat the
  executor's `:783` mutation. Its argument holds statically: on the old code
  `host.get("S")` would be the recreated session, not `undefined`.
- **`SessionSaver.remove`**: correct. The `removed` set drops a later `save`
  and a `settle` that arrives late. The remove is queued on the store's
  per-uid queue, after any save in flight. The behaviour is pinned by
  `session-saver.test.ts:192` (the executor's M-S1/M-S2) and, from the runtime
  side, by my M2 below.

#### Gate (re-run)

`bun run check`: typecheck clean · lint `Checked 432 files … No fixes applied`
(clean) · **2295 pass / 2 skip / 0 fail**, `Ran 2297 tests across 183 files`.
The two skips are the opt-in ones, and the counts are identical to Follow-up 1.

#### Mutations (temporary, reverted)

| # | Mutation | Result |
|---|---|---|
| M1 | `noteDeleted` in `recreate`'s catch never fires | **survived** (257/0) → R2-2 |
| M2 | `onSessionDeleted` does not call `saver.remove` | red: local-runtime F1 |
| M3 | F2: `archived.delete` before `admitLive` | red: F2 |
| M4 | `delete` of an unknown id tombstones it (poisoning) | red: A24 |

After the reverts: `git status --short` lists 40 entries, `git diff | shasum`
is `aeb0808b…`, and `session-tombstones.ts` and `session-archive.test.ts`
have the same hashes as the pre-review snapshot. **The tree is
byte-identical** (this section aside).

#### Attacks tried

1. Torn append, then the next delete → **R2-1** (reproduced).
2. A deleted id revived by a reconnect, `create`, `messages` or a forced
   `reopen`, across a real restart: the serve F1 test covers all four, so this
   holds. The round-1 F1 trace is now `SessionDeleted` in each case.
3. A delete of an unknown id poisoning that id: holds (M4 is red).
4. A reopen at full `maxSessions`, refused part-way: holds (M3).
5. A blocked id → R2-5. An unreadable or garbled file → R2-3/R2-4.
6. §7 invariants: no peer serialization (the tombstone append is
   per-instance and outside `Connection`); no raw terminal write (notices go
   through `NoticeHub` / `onNotice`); pods persist nothing (they have no
   `tombstones`). All hold.

#### How the executor behaved

Well. It implemented both decisions exactly and found and fixed the saver's
late-failure bug itself. It was honest about which tests it did not show red
first and about its debt (a file that only grows, an attached client that
converges late, a failed tombstone write). It missed one thing: it tested the
torn tail in isolation, never followed by another append. That is the step
where the bug lives.

### Owner decision after Review round 2

- **R2-4 (unreadable tombstone file at startup) — refuse to start,
  2026-10-24.** If `deleted-sessions` exists but cannot be read (permissions,
  I/O error), the `serve` daemon does not start: it exits with a clear error
  naming the file and the cause, before taking any connection. Starting
  anyway would let offline clients revive deleted sessions while the only
  signal is a log line nobody sees ("non voglio fallimenti silenziosi"). A
  missing file is not an error (no deletes yet). A single garbled line is
  not a whole-file failure: it is skipped with a startup warning (R2-3).
  *— recorded by the orchestrator (claude-opus-5-5) on the owner's "ok"*

### Review round 3

*— claude-opus-5-5 (fresh context, adversarial reviewer), 2026-10-24.* Scope:
Follow-up 2 only (`session-tombstones.ts`, `serve.ts`, `session-persister.ts`,
their tests, the `remote-client.ts` recreate test). Executor:
claude-sonnet-5-5, so this round has a different model family from the
executor.

#### Verdict: **APPROVE-WITH-NITS** (MERGE)

R2-1…R2-6 and the owner decision on R2-4 are implemented as asked. Every new
test fails under a targeted mutation. The gate is green. The nits below do not
block the merge.

#### Checks

- **R2-1 holds.** I re-ran my torn-line repro on the real `TombstoneFile`
  (`.tentacle/tmp/session-archive/r3-torn.ts`): `add(A)`, then a crash-truncated
  tail `\na1b2c3d4-0000-40`, then `add(B)`, then a reload from a fresh instance:
  ```
  after crash: [ "…0001" ]
  file: "\n…0001\n\na1b2c3d4-0000-40\n…0002\n"
  reload: [ "…0001", "a1b2c3d4-0000-40", "…0002" ] B tombstoned? true
  ```
  `session-tombstones.ts:77` writes `\n${id}\n`, and `:53` skips blank lines.
- **R2-3 holds.** A garbled line (`not an id!`) reaches `onGarbled`
  (`session-tombstones.ts:59`). `serve.ts` turns it into a notice through
  `options.onNotice`. `main.ts` routes that to `write("[daemon] …")` in the
  `serve` process, which has no Ink, so there is no raw write into a TUI.
- **R2-4 holds.** `serve.ts:197` throws from `reloadedHost`. That call runs
  before `listen`, so it happens before any connection. `startDaemon`'s catch
  stops the persister and releases the lock (`serve.ts:142-146`). The message
  names the path and the cause. A missing file (ENOENT) returns `[]`.
- **R2-5 holds.** `session-persister.ts:236` tombstones first. A blocked id's
  file is still left as is.
- **R2-6 holds.** `syncDir` swallows every error. It runs only when `stat`
  failed, which is harmless: at worst there is one extra best-effort fsync.

#### Findings (nits, non-blocking)

1. **N1 — `serve.ts:197`:** the advice "fix or remove the file" invites a
   removal, and a removal silently re-enables every revival the file was
   preventing. That is the outcome the owner's decision exists to avoid. The
   text should say "fix its permissions; removing it lets clients recreate
   the sessions deleted earlier".
2. **N2 — `session-tombstones.ts:52`:** a CRLF line (`…0002\r`) is reported as
   garbled and dropped. This is loud, so it is acceptable: the daemon never
   writes `\r`, so only a hand edit produces one. It is noted here only so
   nobody "fixes" it into a silent trim.
3. **N3:** a torn fragment that is itself a valid id becomes a tombstone
   (`"a1b2c3d4-0000-40"` above). The executor already declared this. It is
   harmless for UUID ids. It would matter only if a session's real id equals
   a prefix of another id.

#### Gate (re-run)

`bun run check`: typecheck clean · lint `Checked 432 files … No fixes applied`
· **2301 pass / 2 skip / 0 fail**, `Ran 2303 tests across 183 files`. These
counts are identical to Follow-up 2, and the two skips are the opt-in ones.

#### Mutations (temporary, reverted)

| # | Mutation | Result |
|---|---|---|
| M-a | `add` appends `${id}\n` (old code) | red: R2-1 |
| M-b | `onGarbled` never called | red: R2-3 unit + e2e |
| M-c | `serve` swallows the load error (returns the host) | red: R2-4 |
| M-d | `remove` returns early for a blocked id (old code) | red: R2-5 |
| M-e | `noteDeleted` in `recreate`'s catch never fires | red: R2-2 (timeout) |

After the reverts: `git status --short` lists 40 entries, `git diff | shasum`
is `3551c71a…`, and `session-tombstones.ts` is `55da2b0e…`. All of these
match the pre-review snapshot, so **the tree is byte-identical** (this
section aside).

#### Attacks tried

1. Torn tail, then delete, then reload: holds (repro above).
2. Blank lines, a garbled line, a CRLF line: skipped and reported (N2).
3. An unreadable file: the start is refused before `listen`, and the lock is
   released (the test re-starts after the file is removed).
4. A blocked id is deleted, then the daemon restarts. The tombstone is on
   disk, and the reload loop finishes the removal (`isDeleted` is checked
   before `unreadable`).

#### How the executor behaved

claude-sonnet-5-5 behaved well. It stayed in scope: each change maps to one
R2 item, and I found nothing extra. Its red→green claims hold, since my
mutations M-a and M-d are exactly the "old code" it cited, and both are red.
It was honest that R2-2 was test-only and passed on the existing code, and
that R2-6 has no test.

### Orchestrator note after Review round 3

- N1 fixed by the orchestrator: the `serve.ts` refusal now says "fix its
  permissions or contents; it records the sessions deleted earlier, and
  removing it lets a client recreate them". Gate re-run: 2301 pass / 2 skip /
  0 fail, typecheck and lint clean. N2 (`\r` line skipped with a warning)
  left as is. *— claude-opus-5-5 (orchestrator), 2026-10-24*
