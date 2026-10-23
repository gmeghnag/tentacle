# feat/session-list — `session/list`: find a daemon's sessions

> **Status:** implementation (plan approved by the owner 2026-10-23)
> **Branch:** `feat/session-list`
> **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (protocol shared truth + the result shape tasks 2, 3, 7, 11 build on, AGENTS §7)

Type: feat · Size: M · Blast: load-bearing · Suited: strong model + fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-23*

Task 1 of `docs/eval/mobile-app.md` decision 21 (row 1: "`session/list`
(title, cwd, updatedAt, running, attached, archived) — M · load-bearing").
It closes gap **G1** of `docs/eval/session-handoff.md` ("a session cannot be
found"): today there is no method that enumerates a daemon's sessions
(`packages/protocol/src/methods.ts:39-54`), so a client can only re-attach an
id it already holds. Every later handoff piece needs it: the phone's session
list (task 11), `connect --resume` / `/sessions` (task 7), archived sessions
(task 2), model titles (task 3).

Decisions this task must respect, from the eval:

- **4 (session lifetime).** After task 2, idle sessions are *archived* (record
  kept on disk, unloaded from memory) and "listed as archived in app and TUI".
  → the result carries `archived` now (always `false` until task 2) so task 2
  only starts producing `true` entries.
- **5 (every client is a view of the session).** Listing is a read of the
  session set; it must not attach, nor move any session's TTL clock.
- **6 (one daemon per project).** "`session/list` entries carry the `cwd`" so
  a later one-daemon-many-projects design needs no rework. The daemon still
  confines every session to its own `defaultCwd`
  (`packages/daemon/src/session-host.ts:5-7`, `:265`).
- **7 (projects appear by themselves).** Out of scope (task 10); list is per
  daemon.
- **17 (titles).** Today a title is `sessionTitle(messages)` — the first user
  message, whitespace-collapsed, cut to 80 (`packages/agent/src/session-store.ts:33-43`).
  Task 3 makes the daemon own a model/user title; the list's `title` field is
  the one place that title surfaces, so task 3 changes only where the daemon
  reads it from, not the wire.
- **Q6 / G6 (auth).** "token = the daemon's owner": any authenticated client
  may list, exactly as any may already open any session (comment at
  `packages/protocol/src/session.ts:265`). Per-device auth is task 9.

Out of scope: any TUI / `connect` UI (task 7), archived records (task 2),
model titles and a title-change broadcast (task 3), a "session set changed"
notification (see Notes/debt in Review when built).

**Repro** (2026-10-23, run from `.tentacle/tmp/session-list-plan/`; workspace
packages resolve through the repo root's `node_modules`):

```ts
// session/list does not exist on current main: a daemon answers MethodNotFound.
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";

const host = new SessionHost({
  defaultCwd: "/tmp/session-list-plan",
  createAgent: () => {
    throw new Error("no agent needed");
  },
});
const [d, c] = createChannelPair();
new Connection(d, host);
const client = new RpcPeer(c, {});
await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
try {
  console.log("result:", await client.request("session/list", {}));
} catch (error) {
  const e = error as { code?: number; message?: string };
  console.log("session/list ->", e.code, e.message);
}
console.log("SessionHost.list:", typeof (host as unknown as { list?: unknown }).list);
process.exit(0);
```

```
$ bun repro.ts
session/list -> -32601 unknown method: session/list
SessionHost.list: undefined
```

After the change the same script must print a `{ sessions: [] }` result.

**Owner answers (2026-10-23, plan approved):**
1. Pagination in v1: **yes**, keyset cursor as designed.
2. Ordering: **not** by `lastActiveAt`. A session must not move up when
   someone merely opens, views or closes it. Order by the last change of the
   CONVERSATION — the end of a turn or a compaction (the busy slot ending).
   `HostedSession` keeps an in-memory `lastChangeAt`, set only when the busy
   slot ends (and at creation); a `serve` reload restores it from the record's
   `updatedAt`; no on-disk format change; `updatedAt = running ? now :
   lastChangeAt`; `lastActiveAt` (TTL) untouched.
3. Unreadable records stay hidden: **yes**.

## Implementation

*— claude-opus-5-5, 2026-10-23*

### Load-bearing assumption

**On a `serve` daemon, the in-memory `SessionHost` registry is, for the
daemon's whole life, exactly the set of sessions a client can open with their
history — so v1 lists the registry alone and reads no disk.** Proof:

- At start every usable record of the project's store is restored into the
  registry before the listener opens: `reloadedHost` lists the store and calls
  `sessionHost.restore(...)` per parsed record (`packages/cli/src/serve.ts:134-158`),
  and `listen` runs only on the host it returns (`serve.ts:171-186`).
  Pinned end-to-end by `A13` (`packages/cli/test/serve-persistence.test.ts:80`).
- A record leaves the disk only together with the registry: `close` deletes
  the map entry, then `persister.remove(id)` (`packages/daemon/src/session-host.ts:154-163`);
  the reaper's close IS `close` (`session-host.ts:236-253`); pinned by `A9`
  (`packages/daemon/test/persistence.test.ts:869`).
- Records that cannot be loaded (corrupt, another project, a newer
  `schemaVersion`) are `block`ed and not restored (`serve.ts:135-151`,
  `packages/daemon/src/session-persister.ts:61-63`): they are not openable
  as that history either (an `open` of that id is `UnknownSession`,
  `session-host.ts:141-143`), so not listing them is consistent; the daemon
  already reports each one as a notice at start.
- Cheap confirmation the method is absent today: the Repro above.

Consequence: until task 2 introduces "persisted but not loaded" (archived),
that category is **empty** on every daemon. Task 2 adds it — see Design §
"Seams for later tasks".

**Second fact the ordering stands on (owner answer 2) — verified FALSE on
`main`, fix included in this task:** the record's `updatedAt` is *not* "the
last conversation change" today. It is the write time
(`toDaemonRecord(state, meta, this.now())`,
`packages/daemon/src/session-persister.ts:86-89`), and the session writes on
events that are not conversation changes:

- **every detach** — `removeAttachment` → `this.persist()`
  (`packages/daemon/src/hosted-session.ts:528-535`, written on purpose so the
  TTL clock survives a restart; pinned by `R1`,
  `packages/daemon/test/persistence.test.ts:962`);
- **construction, including a restore** — `this.persist()` at
  `hosted-session.ts:293-295`, so every `serve` restart re-stamps every
  record's `updatedAt` with the restart time;
- mid-turn boundaries (prompt start `:727`, permission ask/answer
  `:357`, `:376`, `:774`, enqueue `:861`) — harmless for ordering (the
  session is running then, reported as `now`), but they also make the write
  time ≠ the turn's end.

(Attach writes nothing: `attach` has no `persist()` call — only the sites
above, `rg "this.persist\(\)" hosted-session.ts`.)

So restoring `lastChangeAt` from the record's write time would let a
view-and-close (or any restart) move a session up — exactly what the owner
excluded. **Proposed fix, no format change:** the persister writes
`record.updatedAt = state.lastChangeAt` instead of its clock. Same field, same
type, same schema (`DAEMON_RECORD_VERSION` unchanged, `persisted-session.ts:15`);
only its meaning sharpens from "last write" to "last committed conversation
change". Safe because nothing reads a daemon record's `updatedAt` for anything
but `JsonSessionStore.list`'s sort (`packages/agent/src/session-store.ts:459`,
called at `serve.ts:134`, where restore order is irrelevant): `rg updatedAt`
over `daemon/src`, `cli/src` finds only `persisted-session.ts:64,71` on the
daemon side; `cli/src/session-projects.ts:35` and `session-resume.ts:135`
read the LAPTOP store, a different directory. The TTL keeps its own persisted
field (`lastActiveAt`, `persisted-session.ts:54`, `:76`), untouched.

### Preconditions

- **Methods are additive, no bump** (AGENTS §7 "Fields and methods are free";
  `PROTOCOL_VERSION = 10`, `packages/protocol/src/version.ts:7`). An older
  daemon answers `MethodNotFound` from the peer itself, before any handler
  (`packages/transport/src/peer.ts:333-335`) — proved by the Repro. An older
  client never sends it.
- **The client validates every result against `RequestSchemas`; the daemon
  does not validate its own** (`peer.ts:447-457` inbound only; `peer.ts:352-356`
  sends the handler's value as is). So one non-conforming entry fails the
  WHOLE list on the client (`invalid result for session/list`) → the daemon
  must emit a result that is always schema-valid (the `toSkillList`
  precedent, `packages/daemon/src/mapping.ts:63-95`).
- **Handlers run concurrently, never under a lock** (AGENTS §7,
  `peer.ts:332` `handleRequest` per frame). A synchronous handler over the
  map is a consistent read with no lock — the same reasoning as `open`
  (`session-host.ts:127-133`).
- **The registry is the only owner of session state** and already exposes the
  needed facts: `running` (turn or compaction, `hosted-session.ts:501-504`),
  `attachedCount` (`:511-514`), `createdAt` / `lastActiveAt`
  (`:208`, `:221`, `:238-239`, private), the history `this.session.messages`
  (used by `persistedState`, `:486`). Iteration: `SessionHost.values()`
  (`session-host.ts:122-125`).
- **The daemon already computes titles with `sessionTitle`**
  (`session-persister.ts:20`, `:88`) — same function the laptop store uses
  (`session-store.ts:36`), so a daemon list and a local `--resume` list agree.
- **Precedent for "busy ⇒ now"**: a record written mid-turn restores its TTL
  clock as `now` (`restoredActivity`, `packages/daemon/src/persisted-session.ts:334-335`).
- **The busy slot ends in exactly two places**: a turn's end
  (`this.controller = null`, `hosted-session.ts:826-827`, followed by the
  turn-end write `:837-838`) and a compaction's `finally`
  (`:892-900`, which already stamps `lastActiveAt` and writes). These are the
  only `lastChangeAt` stamp sites (plus creation in the constructor,
  `:238-239`).
- **Restore carries state through `RestoredSessionState`**
  (`hosted-session.ts:127-134`, built in `SessionHost.restore`,
  `session-host.ts:182-188`); the persister reads the session through
  `DaemonSessionState` (`persisted-session.ts:41-49`, built by
  `persistedState`, `hosted-session.ts:476-499`).
- **Precedent for an opaque, validated cursor**: `snapshotPage`'s
  `<epoch>/<n>` cursor, `InvalidParams` on a malformed one
  (`hosted-session.ts:604-637`).
- **Ordering precedent**: the store lists newest-updated first, ties by id
  ascending (`session-store.ts:459`).
- **Pod daemons and the worker have no persister** (`session-host.ts:59-63`;
  `packages/cli/src/worker.ts:91`, `serve.ts:237` construct `SessionHost`
  without one) and AGENTS §7 says they never store anything durable.

### Design

#### Wire (protocol, `packages/protocol/src/session.ts`, new section `--- session/list`)

```ts
/** At most this many entries in one `session/list` page (and the max `limit`). */
export const MAX_SESSION_LIST = 200;
/** Max length of a listed title (today's are ≤ 80; task 3's model/user titles fit). */
export const MAX_SESSION_TITLE = 256;

export const SessionListParamsSchema = z.object({
  /** Max entries in this page, 1..MAX_SESSION_LIST. Absent → MAX_SESSION_LIST. */
  limit: z.number().int().min(1).max(MAX_SESSION_LIST).optional(),
  /** Opaque: a previous page's `cursor`. Absent → the first (most recent) page. */
  cursor: z.string().min(1).optional(),
});

export const SessionListEntrySchema = z.object({
  sessionId: SessionIdSchema,
  /** One line, no control characters, never empty ("(empty)" before the first prompt). */
  title: line(MAX_SESSION_TITLE),
  /** The directory the session's tools run against (the daemon's project today). */
  cwd: line(4096),
  /** ms since epoch. */
  createdAt: z.number().int().nonnegative(),
  /** ms since epoch, the daemon's clock: the last conversation change. Never decreases while that clock does not step back. */
  updatedAt: z.number().int().nonnegative(),
  /** A turn or a compaction is running. */
  running: z.boolean(),
  /** Clients attached right now (the lister itself is not one). */
  attached: z.number().int().nonnegative(),
  /** Persisted but not loaded (task 2). Always false until then. */
  archived: z.boolean(),
});

export const SessionListResultSchema = z.object({
  /** Most recently updated first; ties by `sessionId` ascending. */
  sessions: z.array(SessionListEntrySchema).max(MAX_SESSION_LIST),
  /** Present iff more entries follow: pass it back for the next page. */
  cursor: z.string().min(1).optional(),
});
```

`line(max)` = `z.string().min(1).max(max).regex(NO_CONTROL)`, the same rule
as `skills.ts:16-18`. To avoid a third copy, move `NO_CONTROL`/`line` into a
tiny shared non-exported helper (e.g. `protocol/src/text-line.ts`) used by
`skills.ts` and `session.ts`; if that refactor touches the exported schema
document in any way, keep a local copy instead (the drift gate will say).
`Method.SessionList = "session/list"` + its `RequestSchemas` entry
(`methods.ts`). All objects strip (not `.strict()`), per §7.

Field choices, each deliberate:

- **`updatedAt` = `lastChangeAt`, always** (owner answer 2; as built after
  Review — the first plan said `running ? now : lastChangeAt`, and `now` as
  a keyset key made paging skip running sessions, Execution Follow-up 2).
  `lastChangeAt` is a new in-memory stamp on `HostedSession`: set at creation
  and when the history changed — a turn's START (once accepted: after the
  busy check, so a refused prompt stamps nothing), every turn END (success,
  error or cancel), a SUCCESSFUL compaction only; NEVER on attach, detach,
  list, permission answers, enqueue or a failed/cancelled compaction. So
  opening, viewing or closing a session never reorders the list, and a
  running session sits at its turn's start — a key stable for the whole turn.
  Per session it never decreases while the daemon's clock does not step back
  (a turn's end ≥ its start), which keeps the keyset cursor below free of
  skips and duplicates.
  `lastActiveAt` (the TTL clock, `session-reaper.ts:40`) is untouched and not
  exposed.
- **`lastChangeAt` survives a `serve` restart via the record's existing
  `updatedAt`** (fix in Load-bearing assumption):
  - `DaemonSessionState` gains `lastChangeAt` (in-memory capture type only);
    `persistedState()` fills it; the persister passes it as `toDaemonRecord`'s
    `updatedAt` argument instead of `this.now()`. Every write — including the
    detach write and the construction/restore write — now carries the last
    conversation change, not the write time.
  - `RestoredSessionState` gains `lastChangeAt`; `SessionHost.restore` sets
    it to `record.turn ? now : record.updatedAt` — a record cut mid-turn is
    reconciled at reload (notes appended / turn re-asked,
    `reconcileOnReload`), which IS a conversation change at restart time,
    the same rule as `restoredActivity`.
  - A record written by an older build carries write time (possibly a
    detach): one slight over-estimate for that session until its next turn
    ends. Pre-public, no migration (AGENTS §7); noted.
  - Pod daemons / the worker: no persister, nothing changes for them.
- **`attached` is a count**, not a boolean: same quantity as
  `SessionLiveness.attached` (`session-reaper.ts:37`); lets the app say "open
  on 2 devices". `attached > 0` is the boolean.
- **`running` covers compaction too** (`HostedSession.running`), because a
  compaction blocks a prompt exactly like a turn.
- **`title` is sanitised daemon-side** with the existing `wireLine`
  (`mapping.ts:63-66`) and cut to `MAX_SESSION_TITLE`: `sessionTitle`
  collapses whitespace but keeps other control characters (an ESC typed in a
  prompt), which the client schema rejects. An empty result after sanitising
  becomes `"(empty)"` (same label `sessionTitle` uses), never a dropped entry.
- **`sessionId` is not further constrained** (`SessionIdSchema`, as in
  `OpenResult`): the daemon cannot rename a session, and dropping one would be
  a silent loss. A display layer must render ids safely (task 7/11's job —
  noted for them).
- **No `model`, no turn id, no pending-permission flag** in v1: not in the
  row; each is a later additive field (fields are free).

#### Paging (keyset, stable under change)

Order: `updatedAt` desc, then `sessionId` asc. Cursor = opaque
`"<updatedAt>:<sessionId>"` of the last entry returned (split at the first
`:`; `updatedAt` has none). Next page = entries strictly after that key in
the order. Properties:

- No entry is returned twice across pages (keys are unique and an entry's key
  only moves *up*, `updatedAt` never decreasing).
- An entry that becomes active during paging jumps above the cursor and is
  not in later pages — it is at the top on the next refresh (failure modes).
- A cursor survives a daemon restart and a closed session (it is a position,
  not an index): a page after a vanished key just continues after it.
- Malformed cursor (no `:`, non-integer prefix) → `InvalidParams`
  "invalid session list cursor".

Why paging in v1 even though a `serve` registry is capped
(`DEFAULT_MAX_SESSIONS = 64`, `session-host.ts:35`, wired at `serve.ts:117`):
task 2 makes archived sessions unbounded (decision 4: no automatic purge).
A v1 client that never learnt `cursor` would then silently see only the
first page. Shipping `cursor` now makes truncation impossible to miss in the
type (`RemoteClient` returns it).

#### Daemon

- `HostedSession.lastChangeAt` (new private field): `restored?.lastChangeAt
  ?? now()` in the constructor; `= this.now()` at the turn start (in
  `prompt`, after `assertIdle` and the slot is taken), at the turn end (next to
  `this.controller = null`, `:827`; every turn end — success, error or
  cancel — since a turn adds at least the prompt) and after a compaction
  **succeeded** (history replaced; NOT in its `finally`: a failed or
  cancelled compaction left the history and must not stamp — owner decision
  2026-10-23), both BEFORE the write that follows so the record carries it.
- `HostedSession.summary(): SessionSummary` (new, `hosted-session.ts`) —
  `{ id, createdAt, lastChangeAt, running, attached, title }`, where
  `title = sessionTitle(this.session.messages)`. Read-only: touches no stamp,
  no ring, no persister. (`lastChangeAt` is reported as `updatedAt` as is,
  running or not.)
- `persisted-session.ts`: `DaemonSessionState.lastChangeAt`;
  `session-persister.ts:86-89`: pass `state.lastChangeAt` as `updatedAt`.
  `SessionHost.restore` (`session-host.ts:182-188`): add
  `lastChangeAt: record.turn ? now : record.updatedAt` to the restored state.
- **Pure module `packages/daemon/src/session-list.ts`** (React-free, I/O-free,
  AGENTS §7 "logic lives in pure modules"):
  `toSessionList(summaries: Iterable<SessionSummary>, cwd: string, now: number, params: SessionListParams): SessionListResult`
  — maps to entries (sanitised title, `updatedAt` rule, `archived: false`),
  sorts, applies cursor + limit, encodes the next cursor. Also exports
  `parseListCursor`/`encodeListCursor`. Every branch is tested here.
- `SessionHost.list(params)` (new, `session-host.ts`) — **synchronous**:
  `toSessionList([...this.sessions.values()].map((h) => h.summary()), this.opts.defaultCwd, this.now(), params)`.
- `Connection.onRequest`: `case Method.SessionList: return this.host.list(params as SessionListParams);`
  (`connection.ts:159-180`, next to `SkillsList`). After the `initialized`
  gate (`connection.ts:156-158`), like every other method. Does NOT attach.

#### Per runtime

| Runtime | What `session/list` returns |
|---|---|
| `serve` | every session in the registry = every live session + every reloaded record (load-bearing assumption); `archived: false` |
| in-process worker | the worker's registry: in practice the TUI's one session (plus any it recreated); no persister, nothing archived ever |
| pod `run`/`attach` (`serve --stdio`) | the pod daemon's registry: the laptop's own session(s). The pod is untrusted (§7): every string is schema-bounded and control-free on the CLIENT (peer validation), so a hostile pod cannot inject a terminal escape through a title; it can lie about the list — harmless, it is only shown, never acted on without `session/open` |

Task 2 never changes the last two rows: pods and the worker store nothing
durable (§7), so they never have archived sessions.

#### Client (`packages/client/src/remote-client.ts`)

```ts
/**
 * One page of the daemon's sessions (`session/list`), most recent first; pass
 * `cursor` back for the next. Not re-sent after a drop (a fresh read: ask
 * again). An older daemon rejects with `MethodNotFound`. Schema-validated by the peer.
 */
sessionList(params: SessionListParams = {}): Promise<SessionListResult>
```

Same shape and guards as `skillsList()` (`remote-client.ts:312-317`): reject
"not connected to the daemon" when the link is down and redialable; else
`this.call(this.peer, Method.SessionList, params)`. No paging loop, no cache,
no UI wiring (`LocalRuntime` / TUI are task 7).

#### JSON Schema export

`bun run schema:export` regenerates `packages/protocol/schema/protocol.json`
(new `$defs` `SessionListParams`, `SessionListEntry`, `SessionListResult`,
method `session/list`); the drift gate
(`packages/protocol/test/json-schema.test.ts:38-45`) fails until it is
regenerated. Add `FIXTURES` for `methods/session~1list/params` (`{}`,
`{ limit: 50, cursor: "1:s" }`) and `.../result` (empty list; one full entry +
`cursor`) — the agreement test demands a fixture per method
(`json-schema.test.ts:281`). No new `UNKNOWN_ALLOWED` entry (no `z.unknown()`).

#### Seams for later tasks (additive, named)

- **Task 2 (archive):** `SessionHost.list` merges a second source — an
  in-memory index of archived records (`id, title, cwd, createdAt,
  updatedAt` — the record's `updatedAt` IS `lastChangeAt` after this task's
  persister fix, so live and archived sort on the same quantity) that task 2 builds at start (it already `store.list()`s,
  `serve.ts:134`) and updates on archive/delete — into the same
  `toSessionList` input with `archived: true`, `running: false`,
  `attached: 0`. Keep `list` synchronous (no disk read per request; a lock-free
  consistent read, §7). `SessionSummary` gets an `archived` flag; the wire is
  unchanged.
- **Task 3 (titles):** `HostedSession.summary().title` reads the daemon-owned
  title instead of `sessionTitle(messages)`. Wire unchanged.
- **Task 7 / 11 (UIs):** call `RemoteClient.sessionList`; `MethodNotFound` ⇒
  "this daemon is too old to list sessions".
- **Later, not planned:** a host-level "sessions changed" notification so a
  list refreshes live; today a client re-lists (on foreground / pull-to-refresh).

### Files

In dependency order:

1. `packages/protocol/src/session.ts` — `session/list` section: constants,
   three schemas, types. (+ optional `protocol/src/text-line.ts` shared
   `line()`, used by `skills.ts`.)
2. `packages/protocol/src/methods.ts` — `Method.SessionList`, `RequestSchemas` entry.
3. `packages/protocol/schema/protocol.json` — regenerated (`bun run schema:export`).
4. `packages/protocol/test/session.test.ts` (or a new `session-list.test.ts`)
   + `packages/protocol/test/json-schema.test.ts` (fixtures).
5. `packages/daemon/src/session-list.ts` — new pure module.
6. `packages/daemon/src/persisted-session.ts` — `DaemonSessionState.lastChangeAt`.
7. `packages/daemon/src/session-persister.ts` — write `updatedAt = state.lastChangeAt`.
8. `packages/daemon/src/hosted-session.ts` — `lastChangeAt` field + two stamp
   sites, `RestoredSessionState.lastChangeAt`, `persistedState()` fills it, `summary()`.
9. `packages/daemon/src/session-host.ts` — `restore` passes `lastChangeAt`; `list(params)`.
10. `packages/daemon/src/connection.ts` — dispatch case.
11. `packages/daemon/src/index.ts` — export `SessionSummary` type if tests need it.
12. `packages/daemon/test/session-list.test.ts` — new (pure + host);
    `packages/daemon/test/persistence.test.ts` — the record-`updatedAt` tests (R7–R9 below).
13. `packages/client/src/remote-client.ts` — `sessionList()`.
14. `packages/client/test/session-list.test.ts` — new (round trip + guards).

No cli / tui change.

### Failure modes

- **Old daemon** → `MethodNotFound` (-32601) from its peer (Repro); the client
  surfaces it as an `RpcError`; UIs (task 7/11) say "update the daemon". No bump.
- **Old client** never sends it. Nothing changes for it.
- **A title with control characters / > 256 chars** → sanitised + cut on the
  daemon, so the result is valid; without that the whole list fails on the
  client (`peer.ts:450-455`). Pinned by a test and a mutation.
- **Hostile pod daemon** sends an invalid entry → client rejects the whole
  result (`invalid result for session/list`); nothing reaches a UI. Same as
  `skills/list`.
- **Empty registry** → `{ sessions: [] }`, no `cursor`.
- **Exactly `limit` entries left** → no `cursor` (cursor iff more follow; no
  empty last page).
- **Session closed / reaped between pages** → its key vanishes; the next page
  continues after it. A cursor naming a vanished key is still valid.
- **Session updated during paging** → moves above the cursor; not repeated,
  shown at the top on the next refresh. Documented on the schema.
- **Malformed cursor / `limit` out of range** → `InvalidParams` (the cursor
  from the handler; `limit` from the peer's params validation, `peer.ts:338-341`).
- **Concurrent list + open/close/reap** → `list` is synchronous over the map,
  so it sees each session either fully registered or gone (`open` registers
  before attaching, `session-host.ts:147-149`; `close` deletes first, `:159`).
  No await, no lock.
- **Opening / viewing / closing a client reorders nothing**: attach, detach
  and the detach write never touch `lastChangeAt`; the detach write carries
  the unchanged stamp to disk. Pinned by H5 and R7.
- **A `serve` restart reorders nothing**: the construction write after
  `restore` carries the restored `lastChangeAt`, not the restart time (R8).
  Exception by design: a record cut mid-turn is reconciled at reload, so its
  `lastChangeAt` is the restart time (R9).
- **Record from an older build** (write time in `updatedAt`): restored as is,
  at most one over-estimate until its next turn ends. No migration.
- **Listing must not keep a session alive**: `summary()` writes nothing; a
  list does not attach, so the reaper's decision is unchanged. Pinned by a
  test (list, then advance the clock past the TTL → reaped).
- **Clock skew between daemon and phone**: `updatedAt` is the daemon's clock;
  a UI should show relative times computed against the daemon's `now` if it
  matters — out of scope; noted for task 11.
- **Before `initialize`** → `NotInitialized` (`connection.ts:156-158`), like
  every method.
- **Link down** (`RemoteClient` with a factory) → rejects "not connected to
  the daemon" at once, not queued (same as `skillsList`).

### Tests

Red first: every test below is written before its code and shown failing on
`main` (the method / `SessionHost.list` / module do not exist → the Repro's
`-32601`, or a missing export). Record the red output in Execution.

Protocol (`packages/protocol/test/session-list.test.ts`):
- P1 `Method.SessionList === "session/list"` and `RequestSchemas` binds both schemas.
- P2 entry rejects: empty title, title with `\u001b`, title > 256, negative
  `attached`, non-integer `updatedAt`; accepts a full valid entry; an unknown
  extra field is stripped, not rejected (forward compat).
- P3 params: `limit` 0 / 201 / 1.5 rejected; absent accepted; `cursor: ""` rejected.
- P4 result: > 200 sessions rejected.
- Drift + agreement: regenerate, fixtures added (gate goes red before regenerate).

Pure (`packages/daemon/test/session-list.test.ts`, `toSessionList`):
- L1 order: updatedAt desc, ties by id asc.
- L2 running ⇒ `updatedAt = now`; idle ⇒ `lastChangeAt`.
- L3 title sanitised (`"a\u001bb"` → `"a b"`), cut to 256, all-control →
  `"(empty)"`; `archived` is `false`; `cwd` passed through.
- L4 paging: 5 entries, `limit 2` → 2 + cursor, 2 + cursor, 1 + no cursor; the
  union equals the full list, no duplicates; exactly-`limit`-left → no cursor.
- L5 a cursor whose key vanished continues after its position; an entry whose
  `updatedAt` grew after page 1 is not repeated on page 2.
- L6 malformed cursors (`"x"`, `"abc:s"`, `":s"`) → `RpcError` `InvalidParams`.
- L7 every output is `SessionListResultSchema`-valid (property: run over a
  set of hostile titles/cwds).

Host + wire (same file, `SessionHost` with the scripted-agent factory of
`packages/daemon/test/registry.test.ts:107-148`, injected `now`):
- H1 two sessions, one attached and running (a slow model, like
  `registry.test.ts:40` `slowModel`), one detached and idle → the right
  `running` / `attached` / `title` / `cwd = defaultCwd`, over a raw `RpcPeer`.
- H2 listing does not attach and does not move the TTL clock: list, advance
  `now` past `idleTtlMs`, `reapExpired` → the idle session is reaped.
- H3 a closed session is not listed; a `restore`d idle record (detached) is
  listed with `createdAt` and `updatedAt` = the record's `createdAt` /
  `updatedAt` (use the record builder of `persistence.test.ts:1130-1146`).
- H4 `session/list` before `initialize` → `NotInitialized`.
- H5 **attach + detach does not reorder** (owner answer 2): sessions A (turn
  ended at t=10) and B (turn ended at t=20) → order B, A. At t=30 a second
  client opens A and disconnects (and a third opens + `session/snapshot`s
  it). List again → still B, A, A's `updatedAt` still 10 — while A's
  `liveness().lastActiveAt` did move to 30 (proves the TTL clock is untouched
  and the two stamps are distinct).
- H6 a turn ending re-stamps: run a turn on A at t=40 → order A, B, A's
  `updatedAt` 40; a compaction ending at t=50 on B → B first, `updatedAt` 50.

Persistence (`packages/daemon/test/persistence.test.ts`, existing spy store):
- R7 the detach write (as `R1`, `:962`) carries `updatedAt` = the turn's end
  time, not the detach time (`lastActiveAt` = the detach time, as today).
- R8 restore of an idle record with `updatedAt: 7`, at `now = 100`: the
  construction write's `updatedAt` is 7, and `list` reports 7.
- R9 restore of a record with a `turn` (cut mid-turn) at `now = 100` →
  `updatedAt` 100.

Client (`packages/client/test/session-list.test.ts`, copy the harness of
`packages/client/test/skills-list.test.ts:12-58`: `connected(host)`,
`rawDaemon(reply)`):
- C1 round trip over real daemon objects equals the host's `list`.
- C2 an older daemon (`rawDaemon` answering -32601) → rejects with that code.
- C3 a hostile daemon (title with `\u001b`, or 201 entries) → rejects
  `InternalError` "invalid result", nothing returned.
- C4 link down with a channel factory → rejects "not connected to the daemon".
- C5 `limit`/`cursor` are forwarded verbatim (raw daemon records the params).

**Mutations (non-vacuity, §9)** — each must turn a named test red, then revert:
- M1 drop the `wireLine` sanitising in `toSessionList` → L3, L7, and C1 with
  a control-char title go red (the client rejects the list).
- M2 sort ascending → L1, L4 red.
- M3 `updatedAt = lastChangeAt` always (ignore running) → L2, H1 red.
- M4 make `list` call `hosted.attach(...)` or bump `lastActiveAt` → H2 red.
- M5 emit a `cursor` when exactly `limit` entries are returned → L4 red.
- M6 feed `lastActiveAt` instead of `lastChangeAt` into `summary()` (the
  rejected design) → H5 red.
- M7 also stamp `lastChangeAt` in `removeAttachment` → H5, R7 red.
- M8 persister back to `updatedAt = this.now()` → R7, R8 red.
- M9 restore ignores `record.updatedAt` (`lastChangeAt = now`) → R8, H3 red.
- M10 drop the compaction stamp → H6 red.

Gate: `bun run check` (typecheck → lint → test), lint baseline clean (AGENTS §6).

## Execution

*— claude-opus-5-5, 2026-10-23*

**Gate baseline (unchanged tree, before any edit):** `bun run check` exit 0 —
lint `Checked 403 files … No fixes applied`; tests `1979 pass · 2 skip · 0
fail`, `Ran 1981 tests across 165 files`.

**Repro on the unchanged tree** (`.tentacle/tmp/session-list/repro.ts` = the
Context's script, `defaultCwd` `/tmp/session-list`, result printed with
`JSON.stringify`):

```
$ bun repro.ts
session/list -> -32601 unknown method: session/list
SessionHost.list: undefined
```

After the change, same script:

```
$ bun repro.ts
result: {"sessions":[]}
SessionHost.list: function
```

**As built, in plan order:**

1. Protocol — `packages/protocol/src/session.ts:327` new `--- session/list`
   section (`MAX_SESSION_LIST`, `MAX_SESSION_TITLE`, the three schemas + types,
   all strip objects); `line()` moved to the new non-exported
   `packages/protocol/src/text-line.ts`, now used by `skills.ts` and
   `session.ts`; `Method.SessionList` + its `RequestSchemas` entry
   (`methods.ts:50`, `:80`).
2. `bun run schema:export` → `protocol.json` +90 lines, **0 removed**: the
   `line` move left the exported document unchanged (no local copy needed).
   Fixtures `methods/session~1list/{params,result}` added to
   `json-schema.test.ts`.
3. Pure module `packages/daemon/src/session-list.ts`: `SessionSummary`,
   `encodeListCursor` / `parseListCursor` (split at the first `:`, prefix
   `^\d+$` and a safe integer, id non-empty, else `InvalidParams` "invalid
   session list cursor"), `toSessionList` (filter strictly after the cursor
   key → sort → `slice(0, limit)` → `cursor` iff more entries remain).
4. `persisted-session.ts:46` `DaemonSessionState.lastChangeAt`;
   `session-persister.ts:90` writes `updatedAt = state.lastChangeAt`.
5. `hosted-session.ts`: `RestoredSessionState.lastChangeAt` (`:132`); private
   `lastChangeAt` (`:231`), set in the constructor (`:250`), at the turn end
   (`:853`) and in the compaction `finally` (`:922`; moved by the Follow-up
   below to the success path), both before their
   `persist()`; `persistedState()` fills it (`:496`); `summary()` (`:528`).
6. `session-host.ts`: `restore` passes `lastChangeAt: record.turn ? now :
   record.updatedAt` (`:206`); synchronous `list(params)` (`:136`).
7. `connection.ts:180` dispatch case, after the `initialized` gate.
8. `remote-client.ts:327` `sessionList(params = {})`, same guards as
   `skillsList`.

**Red → green** (every new test written before its code; red runs on the
assertion, not on an import — new modules/methods were first added as typed
stubs returning empty / rejecting, and the protocol test reads the schemas
through a namespace import):

- Protocol P1–P4: `0 pass · 4 fail` (`expect(received).toBe(expected)`) →
  green; drift gate + fixture-coverage gate red after the schemas
  (`104 pass · 2 fail`) → green after fixtures + `schema:export`
  (`106 pass · 0 fail`).
- Daemon L1–L7 red on assertions against the stub; H1, H2, H3, H5, H6 red
  with `RpcError: unexpected method: session/list` (protocol had already
  registered the method, so the peer reached the connection's `default`
  branch); R7, R8 red on the `updatedAt` assertion (R8 got 100, not 7); R9
  red on `r.host.list is not a function` (its disk assertion passed on the
  old code, by coincidence: the rig's clock = the reload time). Then
  `56 pass · 0 fail`.
- **H4 is green on both** (the `initialized` gate precedes any dispatch,
  `connection.ts:156-158`): it pins existing behaviour for this method, it
  does not prove the new code.
- Client C1–C5: `0 pass · 5 fail` against a `sessionList` stub that rejected
  "not implemented" → `5 pass · 0 fail`.

**Mutations** (each applied, run over the three test files, reverted):

| | Mutation | Red |
|---|---|---|
| M1 | title not sanitised | L3, L7, C1 |
| M2 | sort ascending | L1, L2, L4, L5, H1, H5, H6, C1 |
| M3 | `updatedAt = lastChangeAt` always | L2, H1 |
| M4 | `list` attaches + detaches a probe (moves the TTL clock) | H2 |
| M5 | `cursor` when exactly `limit` returned | L4 |
| M6 | `summary()` reports `lastActiveAt` | H3, H5 |
| M7 | `removeAttachment` stamps `lastChangeAt` | H5, R7 |
| M8 | persister writes `Date.now()` | R7, R8, R9 |
| M9 | restore `lastChangeAt = now` | R8, H3 |
| M9b (extra) | restore `lastChangeAt = record.updatedAt` always | R9 |
| M10 | no stamp at the compaction's end | H6 |

Tree byte-identical after the reverts: `shasum -a 256` of the four mutated
sources (`session-list.ts`, `session-host.ts`, `hosted-session.ts`,
`session-persister.ts`) equal before and after
(`7c7057a4…`, `510ee0e6…`, `1804979a…`, `888d1dc2…`).

**Gate (final):** `bun run check` exit 0 — typecheck clean; lint `Checked 408
files … No fixes applied` (+5 new files, 0 errors / 0 warnings); tests
`2004 pass · 2 skip · 0 fail`, `Ran 2006 tests across 168 files` — +25 tests
(4 protocol, 13 daemon `session-list`, 3 R7–R9, 5 client) and +3 files vs
baseline; the 2 skips are the opt-in ones.

**Drift from Implementation:**

- `wireLine` is now `export`ed from `daemon/src/mapping.ts` (it was
  module-private) so `session-list.ts` reuses it, as the Design asks. Since
  `index.ts` does `export * from "./mapping.ts"`, it is now also public API of
  `@tentacle/daemon`.
- `PersisterOptions.now` and `SessionPersister.now()` **removed**: the
  persister's only clock use was `updatedAt`, so after the fix they were dead.
  Consequently the `rig` in `persistence.test.ts` no longer passes `now` to
  the persister (the host still gets it). M8 therefore used `Date.now()`.
- Existing `persistence.test.ts` literals of `DaemonSessionState` (×3) and
  `RestoredSessionState` (×1) gained `lastChangeAt: 1` (required field).
- `toSessionList` falls back to `"(unknown)"` for a `cwd` that sanitises to
  empty (the plan only specified `"(empty)"` for titles); unreachable with a
  real `defaultCwd`, there so the result is always schema-valid (L7).
- `SessionSummary` is not exported from `daemon/src/index.ts` (plan step 11 was
  conditional: no test needed it).
- Persistence tests R7–R9 live in a new `describe` block at the end of the
  "review fixes" section, rather than inside it.

**Follow-up (owner decision 2026-10-23: `lastChangeAt` moves only when the
history changed).** A turn end always stamps; a compaction stamps only on
success. The stamp moved from the compaction's `finally` into the `try`,
right after `session.compact` resolved (`hosted-session.ts`, before `return
{ before, after }`), still before the `finally`'s write. New test **H7**
(`daemon/test/session-list.test.ts`): a compaction failing (provider throws)
at t=30 and one cancelled at t=40 leave the order `[B 20, A 10]`, while
`lastActiveAt` moves to 40. Red on the old code (`toEqual` at the
failed-compaction check, :458); green after the fix. A first run of the
cancel half timed out because the test model ignores the abort signal: the
test now releases the model right after `cancel()` (a test fix only). Mutations: the
stamp put back in `finally` → H7 red at :458; extra, a stamp only on the
cancel path in `catch` → H7 red at :477 (the cancel half). Reverted; the
`hosted-session.ts` shasum is the same as after the fix (`e2942bd2…`). M10
(no stamp on success) still reds H6. Narrow `57 pass · 0 fail`. Gate:
`bun run check` exit 0, lint `408 files` clean, `2005 pass · 2 skip · 0
fail` (`Ran 2007 tests across 168 files`; +1 = H7).

**Follow-up 2 (Review, REQUEST-CHANGES: findings 1–3).**

- *Finding 1 (paging skipped running sessions).* The fix gives a running
  session a stable key. The turn's start is itself a conversation change
  (the prompt joins the history), so `HostedSession.prompt` now stamps
  `lastChangeAt` when the turn takes the slot. `toSessionList` drops
  `running ? now` and its `now` parameter: `updatedAt = lastChangeAt` always
  (`session-list.ts`, `session-host.ts` `list`). A running turn sits at its
  start, and the end stamp is ≥ it, so the key is stable across pages and
  only grows. A running compaction keeps its previous stamp, and only a
  successful one stamps (H7 unchanged). A turn resumed at reload already gets
  `lastChangeAt = now` (`record.turn`).
  - Red (each on its assertion): new L8 (pure: 3 running + 1 idle, `limit 2`)
    and H8 (the reviewer's repro through the host: page 2 requested at a
    later clock must list `r3, idle`). L2 and H1 were rewritten to the new
    contract (H1: a running session is listed at its turn start, 25, not at
    the clock, 30). All four were red on the old code, then green.
  - Mutations: M3′, the clock rule put back at the host (`running ? now`),
    reds H1 and H8. M11, no stamp at the turn start, reds H1.
- *Finding 2 (a non-integer stamp broke the whole list).* The record is
  refused at load, the same way an existing malformed field is
  (`parseDaemonRecord` already refuses `lastActiveAt` at
  `persisted-session.ts:160-162`). `serve` then `block`s it and reports
  `skipped <file>: <reason> (left as is)` (`cli/src/serve.ts:146-153`), which
  matches owner answer 3 ("unreadable records hidden") and is loud. New
  check: `createdAt`/`updatedAt` must be non-negative safe integers
  (`isWireStamp`). The laptop store's parser
  (`agent/src/session-store.ts:222-225`) is left alone: it serves the laptop
  store too.
  - Red: a unit test (1.5, −1, 2^53 on both fields) and the reviewer's
    end-to-end repro as R10 in `cli/test/serve-persistence.test.ts` (real
    `serve`, one healthy and one `updatedAt: 1.5` record). Its first red was
    on the property itself: the `session/list` result failed
    `SessionListResultSchema`. After the fix the list holds only `good`, the
    notice names the file, and the file is byte-identical.
  - Mutation M12, `isWireStamp` → `isFiniteNumber`: reds both tests.
- *Nit 3.* The protocol comments (section + `updatedAt`) now say the
  ordering and "never decreases" hold while the daemon's clock does not step
  back. Comments are not in the JSON Schema: the drift gate stays green.
- *Nit 4 (per-entry `cwd`)* is left for task 2, as asked: `SessionSummary`
  gains `cwd` when archived records, which carry their own `record.cwd`, are
  merged in.
- After all reverts, `shasum -a 256` of `session-host.ts` (`752bc3d1…`),
  `hosted-session.ts` (`7dde5042…`) and `persisted-session.ts` (`6fba93ff…`)
  is identical. Narrow: `71 pass · 0 fail`. Gate: `bun run check` exit 0,
  lint `408 files` clean, `2009 pass · 2 skip · 0 fail` (`Ran 2011 tests
  across 168 files`; +4 = L8, H8, the parser unit test, R10).

**Follow-up 3 (Re-review).** R1: new H9 — a prompt refused (busy session; unknown skill) leaves `updatedAt`/order unchanged. It is green on the current code and RED under the reviewer's exact mutation (stamp moved above `assertIdle`: only H9 fails, at `:523`); after the revert `hosted-session.ts` shasum is again `7dde5042…` and H9 is green.
R2: the stale comments now state the current rule (turn start + turn end + successful compaction stamp `lastChangeAt`; `updatedAt = lastChangeAt`): `hosted-session.ts` `lastChangeAt` field, `persisted-session.ts` `DaemonSessionState.lastChangeAt`, and the Design notes (wire snippet, field choices, Daemon bullets).
Gate: narrow `17 pass · 0 fail`; `bun run check` exit 0, lint 408 files clean, `2010 pass · 2 skip · 0 fail` (+1 = H9).

**Notes for later tasks / the owner (unchanged scope):**

- Records written by an older build carry write-time `updatedAt`, so there
  can be one over-estimate per session until its next turn ends (as planned,
  no migration).
- Task 7/11: render `sessionId` safely (only `min(1)` on the wire); treat
  `MethodNotFound` as "daemon too old"; `updatedAt` uses the daemon's clock.

## Review

*— claude-opus-5-5, 2026-10-23. Same model and model family as the planner
and the executor: a fresh context on a separate account, NOT a different
model. Shared blind spots can survive both passes. This task is
`load-bearing`, so AGENTS §10 routing wants a different model too.*

**Verdict: REQUEST-CHANGES.** The wire shape, both protocol ends, the JSON
Schema, the persister's `updatedAt` change and the ordering rules are correct
and well tested. Two defects break the plan's own contracts: "no silent drop"
(AGENTS §8) and "the daemon must emit a result that is always schema-valid"
(Preconditions). Both are small to fix.

### Findings

1. **Keyset paging silently skips running sessions when more of them are
   running than `limit`** (`packages/daemon/src/session-list.ts:81`, `:86`).
   A running entry's key is `now`, and `now` changes on every request. Page 1
   ends inside the running block with cursor `T1:<id>`. On page 2 at `T2 > T1`,
   every running session sorts above that cursor, so the running sessions that
   were not on page 1 never appear in this pass, even though nothing about
   them changed. Repro (`.tentacle/tmp/review-session-list/paging.ts`; three
   running sessions plus one idle, `limit: 2`):
   ```
   page1 [ "r1", "r2" ] 1000:r2
   page2 (1 ms later) [ "idle" ] undefined
   page2 (same now) [ "r3", "idle" ]
   ```
   `r3` is lost. The doc's failure mode "session updated during paging → shown
   at the top on the next refresh" does not cover this case: `r3` was never
   updated, and on a refresh it is still beyond page 1. This is unreachable
   with the default `limit` (200) and `serve`'s cap of 64. It is reachable as
   soon as task 11 asks for small pages (for example `limit: 20`), or task 2
   adds unbounded sessions with many running. No test pins it: L5 covers a
   moved entry, not a moving `now`. Fix direction, for the executor to choose:
   carry the first page's `now` in the cursor and evaluate running entries at
   it, or key running entries on something stable. Add a pure test for it.
2. **One restored record with a finite but non-integer or negative
   `updatedAt`/`createdAt` breaks the whole list, for every session, until
   the next restart** (`packages/daemon/src/session-host.ts:206` restores
   `record.updatedAt` as is; the parser only checks `Number.isFinite`,
   `packages/agent/src/session-store.ts:222-225`; `toSessionList` passes the
   value through, `session-list.ts:79-81`). The client rejects the entire page
   (`peer.ts:447-455`). Repro (`.tentacle/tmp/review-session-list/badstamp.ts`,
   real `startDaemon` plus `RemoteClient`, one healthy record and one with
   `updatedAt: 1.5`): `restored 2 sessions` → `sessionList rejected: invalid
   result for session/list`. This is loud, but one bad file takes out the
   list for every session, and it contradicts owner answer 3 ("unreadable
   records stay hidden": this one loads as readable). L7's property test
   covers titles and cwds only. Fix direction: refuse it at load, so it is
   blocked and a notice is shown (fail-loud, the existing path), by requiring
   non-negative safe integers for `createdAt`/`updatedAt`/`lastActiveAt` in
   `parseDaemonRecord`. Clamping in `toSessionList` is the fallback.
3. *(nit)* "`updatedAt` … Never decreases" (`packages/protocol/src/session.ts`,
   the entry's doc comment) holds only for a monotonic daemon clock. If a
   record's `updatedAt` is in the future (clock skew, a record copied from
   another host) or `Date.now()` steps back, a later turn end stamps a smaller
   value. The only effect is finding 1's class of paging skip. State it as an
   assumption, or take `max(lastChangeAt, now)` at the stamp sites.
4. *(nit, for task 2/6)* `toSessionList` takes ONE `cwd` for all entries
   (`session-list.ts:66`, `:72`). An archived record carries its own
   `record.cwd`, and a symlinked spelling is a different string
   (`serve.ts:141-145` compares by `projectKey`). The wire is per entry, so
   this is still additive: `SessionSummary` gains `cwd`. Name it in "Seams
   for later tasks".
5. *(process)* `main` has moved ahead by `2701df4` (docs only: `TODO.md`,
   `docs/eval/mobile-app.md`). Rebase or merge before merging. No code
   overlap.

### Gate (re-run by the reviewer)

`bun run check` exit 0: typecheck clean; lint `Checked 408 files … No fixes
applied`; tests **2005 pass · 2 skip · 0 fail**, `Ran 2007 tests across 168
files`. These match Execution's final numbers, and the 2 skips are the opt-in
ones.

### Premise table

| # | Premise (cited) | Verdict |
|---|---|---|
| 0 | Context symptom: `session/list` is absent on `main` → `MethodNotFound` | TRUE. `main:methods.ts` has 0 `session/list` matches; `peer.ts:332-335` answers -32601 before any handler. Checked statically, not by running the Repro on a `main` checkout (that needs a second worktree with its own `node_modules`). On the current tree the Repro's path returns `{"sessions":[]}` (E2E below). |
| 1 | serve restores every usable record before listening (`serve.ts:134-158`) | TRUE |
| 2 | `close` deletes the map entry, then `persister.remove` (`session-host.ts`) | TRUE (`:171-180` after the diff) |
| 3 | Bad records are `block`ed and not restored (`serve.ts:135-151`) | TRUE, but the parser's checks are weaker than the wire's (finding 2) |
| 4 | The persister wrote `updatedAt = this.now()` (`session-persister.ts:86-89` on main) | TRUE (diff) |
| 5 | Detach writes (`removeAttachment` → `persist`); attach writes nothing | TRUE (`hosted-session.ts:551-558`; no `persist()` between `attach` `:570` and `:750`) |
| 6 | Only `JsonSessionStore.list`'s sort reads a daemon record's `updatedAt` | TRUE. `rg "\.updatedAt" packages` (non-test): `session-projects.ts:35`, `session-resume.ts:135` and `tui/session-picker.ts` read the LAPTOP store (`<configDir>/sessions`, `main.ts:435`), separate from `<configDir>/daemon` (`serve.ts:69`). The resume picker's meaning is unchanged. |
| 7 | Methods are additive: unknown → `MethodNotFound`; bad params → `InvalidParams` from the peer (`peer.ts:333-341`) | TRUE (E2E: `limit: 0` → -32602 "invalid params for session/list") |
| 8 | The client validates results; the daemon does not validate its own (`peer.ts:447-457`) | TRUE. This is what makes finding 2 a whole-list failure. |
| 9 | The busy slot ends only at the turn end and in compaction's `finally` | TRUE (`:850-853`, `:922-928`). `Session.compact` always replaces the history when it resolves (`agent/src/session.ts:151-163`), so the success-path stamp is exact. |
| 10 | `restoredActivity`: busy ⇒ now (`persisted-session.ts:334-337`) | TRUE |
| 11 | The ordering precedent is the store's sort: desc, ties by id asc (`session-store.ts:459`) | TRUE |
| 12 | Pod daemons and the worker have no persister | TRUE (`serve.ts` `startStdioDaemon` and the worker build `SessionHost` without one) |

### Mutations (reviewer's own; each applied, run, reverted)

| Mutation | Result |
|---|---|
| A: title not sanitised (`session-list.ts:77`) | L3, L7, C1 red |
| B: `removeAttachment` also stamps `lastChangeAt` | R7, H5 red |
| C: compaction stamp in `finally` instead of on success | H7 red |
| D: `SessionListEntrySchema` `.strict()` | P2 red (the forward-compat strip is pinned) |

Tree byte-identical afterwards: the `shasum -a 256` of `session-list.ts`,
`hosted-session.ts`, `protocol/src/session.ts` and `session-persister.ts`
diffed equal to the pre-mutation snapshot (`7c7057a4…`, `e2942bd2…`,
`eb283f55…`, `888d1dc2…`), and `git status --short` matched the pre-mutation
snapshot.

### Attacks tried

1. **Running sessions vs the keyset cursor.** FOUND finding 1.
2. **A readable but out-of-contract record.** FOUND finding 2.
3. **The `updatedAt` meaning change against every reader** (laptop store,
   `findInOtherProjects`, the resume picker). Nothing found: every reader is
   on the laptop directory.
4. **E2E through real `serve`** (`.tentacle/tmp/review-session-list/e2e.ts`:
   `startDaemon`, real disk, WebSocket). A seeded session with an ESC in its
   title: listed with `attached:1`, then `attached:0` after detach, and
   `updatedAt` unchanged (`1792748523872`). Record on disk: `updatedAt` =
   creation, `lastActiveAt` = detach (`…887`). After a `serve` restart: the
   same `updatedAt` in the list and on disk (the restore write did not
   re-stamp it). Title sanitised to `remember [31m me`. Bad cursor → -32602.
   Holds.
5. **§7 don't-serialize-the-peer.** `list` is synchronous over the map, with
   no await and no lock (`session-host.ts:136-143`). Holds.
6. **§7 protocol both ends.** `Method` + `RequestSchemas` + client method +
   daemon dispatch + JSON Schema regenerated + fixtures. Strip objects
   (mutation D). No new update kind, so no `UPDATE_CLASS` change; no
   `PROTOCOL_VERSION` bump needed (additive method). Holds.
7. **§7 persistence (serve vs pod/worker).** Only the persister path
   changed. Pods and the worker have no persister, so for them only the
   in-memory stamp exists. `DAEMON_RECORD_VERSION` is unchanged and correct:
   the field and type are unchanged. Holds.
8. **List keeps a session alive?** `summary()` writes nothing (`hosted-session.ts:528`), and H2 pins it.
   Holds.
9. **Additivity for tasks 2/3/7/11.** `archived` is already on the wire, and
   the title source is internal. A per-entry `cwd` needs an internal change
   only (finding 4). Paging must be fixed before task 11 relies on small
   pages (finding 1).

### What holds

Protocol shape and bounds; the persister fix and its three readers; ordering
by the last conversation change (attach, detach, view and restart reorder
nothing, as pinned by H5/R7/R8 and the E2E); compaction stamps only on
success (H7); client guards (older daemon, hostile daemon, link down). The
existing mutation table is credible: I re-ran four, and all went red.

### How the executor behaved

Disciplined. It ran red before green, on assertions rather than imports. It
flagged honestly that H4 is green on both trees. It listed every drift (the
`wireLine` export, the persister's dead `now` removed). It confirmed the
tree was byte-identical after its mutations, and its gate numbers are
exact. Its blind spot was the same one the plan had: it treated `now` as a
fixed value inside a keyset key, and it trusted the record parser's
validation to match the wire's.

### Re-review (after Execution "Follow-up 2")

*— claude-opus-5-5, 2026-10-23. Same reviewer context as above, and the same
model family as the executor, so the caveat above applies.*

**Verdict: APPROVE-WITH-NITS.** Both findings are fixed and proven through
the real code path. The new design choices hold under attack. What is left
is one test gap and some stale comments; none of it blocks a merge.

**Repros re-run**

1. *Paging with running > `limit`*, now through the real `SessionHost` with
   an injected clock (`.tentacle/tmp/review-session-list/paging2.ts`): three
   sessions running a hung model from t=500, one idle from t=100, `limit: 2`,
   page 1 at t=1000 and page 2 at t=5000:
   ```
   page1 [ "r1@500*", "r2@500*" ] 500:r2
   page2 [ "r3@500*", "idle@100" ] undefined
   ```
   No skip. FIXED.
2. *Non-integer `updatedAt`, end to end* (`badstamp.ts` on a fresh `serve`
   store, real `startDaemon` and `RemoteClient`): the notices are `skipped
   …/<id>.json: "updatedAt" is not a non-negative integer (left as is)` and
   `restored 1 session`. `sessionList()` returns only `good-one`. FIXED. (A
   first run on my stale store skipped both files: my own script had left
   the "good" copy at `2.5`, so that was correct behaviour, not a
   regression.) The original E2E trace (`e2e.ts`: detach and restart do not
   re-stamp, title sanitised, bad cursor/limit → -32602) still holds on the
   new code.

**Attacks on the new design**

- *Turn START stamps `lastChangeAt`: does anything rely on it meaning
  "end"?* Holds. `rg lastChangeAt packages` (non-test) has exactly two
  readers: the persister (`session-persister.ts:90` → record `updatedAt`)
  and `toSessionList` (`session-list.ts:82`). The record written mid-turn
  now carries the turn's start, but on reload `record.turn ⇒ now`
  (`session-host.ts:205`) supersedes it, so no reader sees the difference.
  The laptop store, `findInOtherProjects` and the resume picker read
  `<configDir>/sessions`, never the daemon record. Their meaning is
  unchanged.
- *A rejected or retried prompt stamps wrongly?* The code holds. The stamp
  (`hosted-session.ts:735`) comes after the retry short-circuit (`:714-717`),
  after `assertTextOnly` and the skill check (`:719-726`), and after
  `assertIdle` (`:727`), so a rejected prompt records nothing. The only
  other slot taker is the reload-resume (`:298`), whose `lastChangeAt` is
  already `now`. The stamp is also never above the end stamp (same clock,
  `:857`), so a key only grows. Compaction keeps its previous stamp while
  running and stamps only on success (H7). **But no test pins it** (finding
  R1).
- *Refusal at load: loud everywhere? Consistent? Can it strand a session?*
  Holds. `parseDaemonRecord` has one production caller,
  `serve.ts:145`. It `block`s the id, so the daemon never overwrites the
  file, and it prints a notice; the file is left as is (R10 checks the
  bytes). No build ever wrote such a value: the stamp was `Date.now()`,
  and is now `this.now()`, integer ms. So only a hand-edited or foreign
  file is refused, and the laptop keeps its own copy of the conversation.
  `lastActiveAt` keeps the finite-only check. It is consistent enough,
  because it never reaches the wire: it is only the reaper's input.

**Findings**

- **R1 (test gap, should fix).** Mutation G: I moved the turn-start stamp
  above `assertIdle` (`hosted-session.ts:727`), so a prompt rejected as
  `TurnInProgress`/`CompactInProgress` re-stamps. It SURVIVES (`session-list`
  + `persistence` + `registry`: 75 pass · 0 fail). If that regression
  happened, a busy session's key would move mid-paging, which is the
  finding 1 class again. Add a test: a second prompt on a running or
  compacting session leaves `updatedAt` unchanged.
- **R2 (nit, stale comments).** `hosted-session.ts:227` ("the busy slot
  ending … or creation") and `persisted-session.ts:45` ("The last end of a
  turn or a compaction") do not mention the turn-start stamp. Design §
  "Field choices" (`:269-275`) still explains "hence `now`" under its
  "Superseded" note. Align them with the protocol comment.

**Mutations (reviewer's own; each applied, run, reverted)**

| Mutation | Result |
|---|---|
| E: `toSessionList` `updatedAt = running ? Date.now() : lastChangeAt` | L2, H1 red. L8/H8 stay green because a wall-clock mutation is invisible to tests with an injected clock; the executor's M3′ (the host's clock) reds H8. Killed. |
| F: `isWireStamp` → `isFiniteNumber` (`persisted-session.ts`) | parser unit test + R10 red |
| G: turn-start stamp before `assertIdle` | **survives** (R1) |

Tree byte-identical afterwards: `shasum -a 256` of `session-list.ts`
(`de664bfa…`), `hosted-session.ts` (`7dde5042…`) and `persisted-session.ts`
(`6fba93ff…`) diffed equal to the pre-mutation snapshot. `git status --short`
lists exactly the executor's 20 paths.

**Gate (re-run):** `bun run check` exit 0. Typecheck clean; lint `Checked
408 files … No fixes applied`; tests **2009 pass · 2 skip · 0 fail**, `Ran
2011 tests across 168 files`. These match Follow-up 2's numbers, and the 2
skips are the opt-in ones.

**Executor behaviour (Follow-up 2).** It fixed the cause, not the symptom:
a stable key, rather than a cursor carrying `now`. It turned both of my
repros into tests that went red first. It rewrote L2/H1 openly to the new
contract and marked the Design text as superseded instead of deleting it.
Its gate numbers are exact. The one gap is the busy-rejection case its own
design comment depends on.
