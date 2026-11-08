# feat/session-log-laptop-store — the laptop session file becomes the typed event log (`<uid>.jsonl`)

> **Status:** executed (2026-11-07); fresh-context Review pending
> **Branch:** `feat/session-log-laptop-store` (to open off `main` @ `8232b39`)
> **Type:** feat · **Size:** **L** (was M; see Q1) · **Blast:** load-bearing (§7 persistence invariant + its wording, "a pod is not trusted", on-disk versioning, the laptop's only durable copy of a pod run) · **Suited:** strong model executes; mandatory fresh-context Review (`docs/REVIEWER-BRIEF.md`) red-teaming §7 persistence / pod-not-trusted / on-disk versioning / several writers
>
> Task 2 of 3 decided in `docs/eval/session-persistence-format.md` "## Owner decisions (2026-11-07)": `feat/session-log` (done, `47e193f`) → **this** → `feat/session-log-serve-store` (task 3, sketch at the end).

## Context

*— claude-opus-5-5, 2026-11-07*

**Problem.** Task 1 made the laptop↔daemon read-back a typed log (`session/log`), but the
laptop still writes today's JSON record: every save (one per committed round,
`packages/cli/src/local-runtime.ts:463-465`, plus turn end / compaction / title / idle)
rewrites the WHOLE `<uid>.json` (`packages/agent/src/session-store.ts:516-551`, temp + fsync +
rename). The entries the client validated (`ReadBack.entries`,
`packages/client/src/remote-client.ts:197-198`, "what the disk log appends (task 2)") are thrown
away. Superseded history (compaction, `context_reset`) is lost on disk. A divergent copy from
another writer silently replaces the file; only a strict-prefix copy goes aside (Q6,
`session-store.ts:412-417`, `:529-545`). The mid-turn close (`cutHistory`) runs at SAVE time
(`local-runtime.ts:279-298`, `:387-395`) with a length hack (`lastMidTurnCount`, `:356`, `:391`)
that exists only to keep Q6 from misfiring.

**Owner decisions this task implements (binding):**
- the laptop file becomes `<uid>.jsonl`, one format everywhere; the writer writes the
  VALIDATED, RE-SERIALIZED entries the client returns (F4), never raw pod bytes;
- existing JSON records (178 on the owner's laptop, measured below) are converted LAZILY:
  read `.json` when there is no `.jsonl`, write the log at the next save; never lose or
  rewrite history silently;
- `sessions.keepSuperseded: boolean`, default `false`, covers compaction + `context_reset`
  (not `/clear`: new uid, the old file stays intact, `tui/src/App.tsx:1814-1820`); default
  behaviour = today's (superseded history not kept);
- turn markers (`turn_start` / `turn_end` / `call_started`, emitted since task 1,
  `packages/daemon/src/session-log.ts:131-141`) get their disk reader: `cutHistory` moves to
  LOAD;
- remove the Q6 guard and the whole-file JSON rewrite path where the log replaces them;
- the §7 persistence wording is updated on this branch (exact text below, Q14);
- owner rule: NEVER add or change a `critical` value. **This plan adds no entry type and
  changes no value** (`protocol/src/session-log.ts:181-191` untouched). The one place that
  might have needed a type (the file header) is designed as a non-entry (Q3).

**Constraints.** No wire change (no schema change, no `PROTOCOL_VERSION` bump): everything this
task needs is already on the wire (only a pure helper moves into `@tentacle/protocol`, Files 1). `connect` keeps no laptop copy (`packages/cli/src/connect.ts`: no
saver/readBack/store reference, grep count 0): untouched. The `serve` daemon store keeps
`JsonSessionStore` (`packages/cli/src/serve.ts:122`, `packages/daemon/src/session-persister.ts`)
until task 3, so `JsonSessionStore` is NOT changed in a way serve sees.

**Repro** (2026-11-07, `main` @ `8232b39`, `.tentacle/tmp/session-log-laptop-store/repro.ts`,
the real `JsonSessionStore` with a counting `SessionStoreIo`):

```ts
// Repro (feat/session-log-laptop-store Context): today the laptop store rewrites the WHOLE
// record at every save (one per committed round), keeps no log, and a reseeded/divergent
// copy from another writer silently replaces the file (only a strict-prefix copy goes aside).
// Usage (from this folder): bun repro.ts
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonSessionStore, type SessionStoreIo } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";

const dir = join(import.meta.dir, "repro-store");
await rm(dir, { recursive: true, force: true });
let written = 0;
let writes = 0;
const io: SessionStoreIo = {
  async writeDurable(path, data) {
    written += data.length;
    writes++;
    await Bun.write(path, data);
  },
};
const asides: string[] = [];
const store = new JsonSessionStore(dir, io, (a) => asides.push(a.file));
const id = "11111111-2222-3333-4444-555555555555";
const messages: ChatMessage[] = [{ role: "system", content: "s".repeat(6000) }];
while (JSON.stringify(messages).length < 2_000_000) {
  messages.push({ role: "assistant", content: "a".repeat(900), toolCalls: [{ id: `c${messages.length}`, name: "x", arguments: "{}" }] });
  messages.push({ role: "tool", content: "t".repeat(1500), toolCallId: `c${messages.length - 1}` });
}
const rec = (m: readonly ChatMessage[]) => ({ id, cwd: "/w", model: "m", createdAt: 1, updatedAt: Date.now(), title: "t", messages: m });
await store.save(rec(messages));
for (let round = 1; round <= 3; round++) {
  written = 0;
  writes = 0;
  messages.push({ role: "assistant", content: `round ${round}`, toolCalls: [{ id: `r${round}`, name: "x", arguments: "{}" }] });
  messages.push({ role: "tool", content: "ok", toolCallId: `r${round}` });
  await store.save(rec(messages));
  console.log(`save after round ${round} (+2 small messages): writes=${writes} bytes written=${written}`);
}
// Another writer's DIVERGENT copy (a reseeded daemon: same prefix, different tail).
const divergent = [...messages.slice(0, -4), { role: "user", content: "D2's turn" } as ChatMessage];
await store.save(rec(divergent));
const back = await store.load(id);
console.log(
  `divergent copy saved: file now ends with ${JSON.stringify(back.status === "ok" ? back.record.messages.at(-1)?.content : back.status)}; asides=${asides.length}; files=${(await readdir(dir)).join(",")}`,
);
await rm(dir, { recursive: true, force: true });
```

Output:

```
save after round 1 (+2 small messages): writes=1 bytes written=2104006
save after round 2 (+2 small messages): writes=1 bytes written=2104279
save after round 3 (+2 small messages): writes=1 bytes written=2104552
divergent copy saved: file now ends with "D2's turn"; asides=0; files=11111111-2222-3333-4444-555555555555.json
```

Two small messages cost a 2.1 MB rewrite, and the divergent copy replaced 4 messages with no
aside and no notice. After this task: a round appends only its own lines, and a divergent
writer's content is set aside, never dropped silently.

**Measurements** (2026-11-07, this laptop, APFS; scripts in the appendix; the owner's store was
only READ):

| What | Result |
|---|---|
| Real store (`~/.config/tentacle/sessions`) | 28 project dirs, **178** `<uid>.json`, 0 asides, 0 temps; 34.7 MB total; median 67 KB, p90 558 KB, max 1.44 MB; top-level keys exactly `id,cwd,model,createdAt,updatedAt,title,messages` (no `archivedAt` on the laptop) |
| Today's listing (read + `JSON.parse` of all 178, no validation) | **106 ms** |
| stat + first 4 KB of each file | **7.4 ms** |
| JSONL conversion in memory (header + `base` + `message` entries, compact) | 37.6 MB vs 34.6 MB pretty JSON: **×1.085** (worst file ×1.675: a tiny session where envelopes dominate); `JSON.parse` of every JSONL line: **52 ms** |
| Per save, 2 MB record: today (temp + write + fsync + rename) | **2.05 ms** median |
| Per save: append one 3 KB line + fsync | **0.08 ms** median (no fsync: 0.07 ms) |
| Torn tail (half a line, no `\n`) → truncate to the last `\n` | 1514 B dropped, every remaining line parses |
| Append growth from `contextUsage` re-sends (`replace` carries the whole message, `agent.ts:1156`) | upper bound **+16.3 %** of the projection (2001 of 26 156 messages annotated); markers ≈ 0.3 MB for 688 turns |

`fsync` here is Bun's `FileHandle.sync()` = `fsync(2)`. On macOS that does NOT issue
`F_FULLFSYNC`: it survives a process crash and a kernel panic, not necessarily a power loss
(drive cache). That is exactly today's policy (`session-store.ts:140-150`), so the parity holds.

## Implementation

*— claude-opus-5-5, 2026-11-07*

### Owner amendments (2026-11-07, part 1) — they override the text below

*— claude-opus-5-5 (executor), 2026-11-07; citations re-verified on `be2ef89`*

- **No legacy JSON at all.** Struck from the plan: step 0 and step 5 of §3 (`.json` read,
  conversion, delete/aside of the old file), the `.json` fallback of `load`/`scan`, FM 3,
  the `.json` half of FM 17/19, tests W7 and W8, and Q6. The store reads only
  `<uid>.jsonl`; a `<uid>.json` in the folder is ignored silently (not listed, not an
  error). `parseSessionRecord` stays in `@tentacle/agent` for `serve`.
- **Q10 changed: `--in-process` writes the same `.jsonl`.** `saveSnapshot(record)` = a
  REPLACE with a laptop-minted segment (`segmentFromMessages`, one `laptop-<uuid>`
  incarnation per writer and session), atomic, under the lock, `keepSuperseded`
  ignored. The containment rule of §3 applies to it too: the writer's OWN earlier save
  (same laptop incarnation) is replaced as is (a compaction); another writer's content
  that this copy does not contain goes aside first. This replaces the "Q6 kept for the
  in-process path" of §5/§6 and W14. `--in-process` itself stays (separate task).
- **§7 wording** = the text below minus "Legacy `<uid>.json` records are read as they
  are and converted at their next save."
- Every other recommendation (Q1–Q5, Q7–Q9, Q11–Q14) as written.

### Load-bearing assumption

> **The laptop can mirror the daemon's log on disk EXACTLY from `readBack` alone, and can
> tell from the file's last line when it cannot.** (i) Every entry the client commits passes
> through exactly one `readBack` return, in order. (ii) Folding a read's `entries` onto the
> projection the file holds gives exactly `back.messages`, when the file's head is the read's
> start. (iii) Every other case (a skipped or failed persist, another writer, a crash, a cold
> read) is visible to the writer as "the file's last entry is not where this read started",
> and the writer then holds enough (its current segment's entries) to rewrite instead of
> splicing.

**Status: PROVEN statically on `main` @ `8232b39`; pinned empirically FIRST in Execution by
test W1, before any other wiring (as task 1's D1 was).**

Proof:

1. *One commit site, one return.* The client's log state advances at exactly one place,
   `entry.log = applied.state` (`remote-client.ts:1255`), inside `readLog`, and the same
   `applied.entries` is returned at `:1261-1267`. `readLog` is called only from `readBack`
   (`:1181`, `:1186`). `readBack`'s only persistence consumer is `persistingController`
   (`local-runtime.ts:364`). The recreate paths only READ `entry.log` (`logBaseOf`, `:2025`).
   So no committed entry bypasses a `readBack` return.
2. *The fold is the reader's.* `applyLogRead` projects with a pure fold
   (`client/src/session-log-reader.ts:141-206`): `base` resets (`:159-166`), `message` appends
   (`:167-173`), `replace` sets an index (`:174-180`), `truncate` shortens (`:181-187`), and
   `checkpoint` / `title` / turn markers do not touch the projection (`:188-201`). A linear read
   starts from `held.messages` (`:141`), and it is linear iff `first.prev === held.head.id` and
   `seq` is +1 (`:111-112`). Unknown entries are dropped only when not `critical` (`:264-269`),
   so they never change a projection. The disk fold reuses exactly these rules (one pure
   function, shared). So `fold(file) === back.messages` whenever the file's fold is
   `held.messages` at the read's start.
3. *The cases where (2)'s precondition fails are all detectable.* A persist is skipped when
   the read is empty (`local-runtime.ts:373`) or after a hand-over (`:751-753`). A write can
   fail (the saver reports it, `session-saver.ts:95-102`). Another process can write
   (several TUIs of a detached run, `fix/run-session-never-saved` review L3). A read can be
   cold or from a `base` (`session-log-reader.ts:116`, `:136-138`). In every one of them, the
   writer's remembered pair (the file head it last wrote, the client head it last wrote from)
   differs from (the file's actual last line, this read's start). That check needs one tail
   read under the session's lock. On a mismatch, the writer rewrites from its in-memory
   current segment, which every read rebuilds or extends (a read from a `base` always carries
   a complete segment: `:136-138` plus the `count` check `:203-205`).

The one gap in (3): the client head can be an entry F4 dropped, so it is never on disk (task 1
review L2). That is why the writer compares its OWN remembered pair, never "file head ==
client head".

### Preconditions (verified on `main` @ `8232b39`)

- **P1** Entries are self-describing and segmented: envelope `type/seq/id/prev?/ts/critical?`
  (`protocol/src/session-log.ts:57-73`), segments start at `base{inc, reason, count, turn?}`
  (`:88-96`), and the title is re-logged at every segment start
  (`daemon/src/session-log.ts:233-256`), so a file holding only the last segment still has
  its title.
- **P2** `ReadBack` today = `{messages, title?, entries, aside?, gap?}`
  (`remote-client.ts:194-207`). It does NOT expose where the read started, its head or its
  outcome. This task adds them (client-only type, no wire change).
- **P3** The daemon retains the current and the previous segment (task 1 Q7). A reader that
  saves every round gets the old segment's tail before a `base{compact|context_reset}` in a
  LINEAR read. So "keep superseded" is exact for it.
- **P4** Laptop store readers: `resolveResume` (`list()` for the picker / `--continue` /
  newest, `cli/src/session-resume.ts:89`; `load(uid)` `:63`), `findInOtherProjects`
  (`cli/src/session-projects.ts:33`), `readSessionRecord` (`cli/src/tui-sessions.ts:137-146`,
  used by `main.ts:1432` attach `readRecord` and `:1518` plain re-attach). Writers:
  `SessionSaver` via `persistingController` (`local-runtime.ts:750-765`, aside `:771-782`) for
  the worker, `run`, `attach` and the relay (`relay.ts:343` → the same `openTuiSessions`);
  and the in-process fallback `inProcessSessions` → `saver.save(recordFromSnapshot(...))`
  (`main.ts:1686-1697`, `cli/src/session-jobs.ts:130-133`), which has NO daemon and NO log.
  The TUI's `/sessions` reads the daemon's `session/list` (`tui/src/commands.ts:31`), not the
  laptop store. The kept index reads only `record.id` (`cli/src/kept-index.ts:145-167`).
  `archivedAt` exists only in the serve record (`serve.ts:252`); the measured laptop records
  have none.
- **P5** Asides are named `<uid>.stale-<ms>-<8hex>.aside` (`session-store.ts:184`, `:466`,
  `:534`). `scan` takes only `*.json` (`:681-686`), so no listing or load ever takes an aside.
  `remove` deletes them (`:602`, `:611-624`). Temps are swept (`:558-579`).
- **P6** `labelUnansweredCalls` only PUSHES (`daemon/src/persisted-session.ts:497-513`), and
  `cutHistory` only appends (`local-runtime.ts:279-298`). So a raw mid-turn projection is a
  prefix of its cut form. Moving the cut to load therefore never makes the disk copy "not
  contained" in the reseeded one.
- **P7** `call_started{callId}` is emitted on the same `tool_phase running` event that feeds
  `RemoteSession.runningCalls` (task 1 §5; `daemon/src/session-log.ts:139-141`), so the
  open turn's `call_started` set = the `started` set `cutHistory` gets today
  (`local-runtime.ts:393`).
- **P8** A cross-process lock pattern exists: `acquireStoreLock` (`daemon/src/session-persister.ts:300-345`,
  `wx` + pid, dead holder taken over). Its documented limit is a reused pid.
- **P9** `SessionSnapshot` is `{id, messages}` only (`agent/src/session.ts:21-24`): the
  in-process path cannot tell a compaction from a rewrite.
- **P10** `@tentacle/agent` does not depend on `@tentacle/protocol` (its `package.json`);
  `@tentacle/daemon` depends on protocol and agent, and `cli` depends on daemon.
  The new store goes in `daemon` (it needs the entry schemas; task 3's persister is there).
- **P11** No `sessions` key in the file config yet (`config/src/schema.ts`: top level has
  `model` `:189`, `tui` `:314`, …).

### Design

#### 1. The file

```
{"format":"tentacle-session-log","schemaVersion":1,"id":"<uid>","cwd":"…","model":"…","createdAt":1730…}
{"type":"base","seq":49,"id":"<inc>/49","prev":"<inc>/48","ts":…,"critical":true,"inc":"…","reason":"seed","count":3}
{"type":"message","seq":50,"id":"<inc>/50","prev":"<inc>/49","ts":…,"critical":true,"message":{…}}
…
{"type":"turn_start",…} {"type":"call_started",…} {"type":"turn_end",…} {"type":"checkpoint",…}
```

- **Line 1 = the file header, NOT a log entry** (no `type`, so no `critical` value to decide:
  Q3). `schemaVersion` = `LAPTOP_LOG_VERSION = 1`. An unknown version → `unreadable`
  (Failure mode 14). The header holds only the immutable facts (`id` = the file name, checked
  as today `session-store.ts:353-355`; `cwd`, `model`, `createdAt`).
- **Lines 2… = `KnownLogEntry` JSON** exactly as the client re-serialized them
  (`JSON.stringify` of the zod-parsed value), one per line, `\n`-terminated. Never raw
  frames.
- `updatedAt` = the file's `mtime` (Q4: every save writes the file; no read needed).
- `title` = the last `title` entry of the current segment (P1). `source: auto` → derived
  from the projection (`sessionTitle`, as `encodeTitle` does today, `session-store.ts:69-76`).
- With `keepSuperseded: false` (default) a file is the header + ONE segment. With `true` it is
  the header + the superseded segments in order + the current one. The projection is always
  the LAST complete segment's fold.

#### 2. Pure module `packages/daemon/src/session-log-file.ts` (no I/O, unit-tested)

- `parseLogFile(text, id) → {header, segments: Segment[], torn: number, stray: number} | {error}`:
  - split on `\n`. The LAST piece without a terminating `\n` is a **torn tail**: ignored and
    counted. Any other line that fails `JSON.parse` / its schema → `error` (corruption is
    loud, never skipped).
  - each line: an unknown `type` → refused if `critical: true` ("update tentacle"), else
    skipped and counted. A known type → `KnownLogEntrySchema` (the same schema the client
    uses).
  - structure, per segment: a `base` owes `count` `message` lines. `replace.index < length`,
    `truncate.length ≤ length`. `seq` strictly increases inside a segment, and an exact
    duplicate `id` (same id seen twice) is skipped: the defence for a lock lost to a stale
    takeover (FM 4). **`prev` adjacency is NOT re-verified on disk** (task 1 review L2: F4
    drops leave holes; the writer, not the reader, guarantees continuity).
  - a LAST segment whose `base` owes messages at EOF (a torn append of a compaction batch) →
    dropped as torn; the previous segment is the projection (only possible with
    `keepSuperseded: true`; with `false` a compaction is an atomic rewrite).
- `fold(segment) → {messages, title?, openTurn?: {turnId, started: Set<callId>}}`: the
  reader's fold (proof 2), moved out of `session-log-reader.ts:154-202` into ONE pure function
  in `@tentacle/protocol` (`foldEntries`, Files 1) that both call, so the two cannot drift. A turn is open from its `turn_start` (or a `base.turn`)
  to its `turn_end`.
- `closeAtLoad(messages, openTurn) → messages` = today's `cutHistory` (moved here from
  `local-runtime.ts:279-298`). It applies when a turn is open at EOF, with
  `started = openTurn.started`, and as a safety net when the tail has unanswered calls with no
  open turn (`started = null`, the reload rule, `persisted-session.ts:483-489`). Nothing else
  changes: a CLOSED turn ending on a prompt stays as today (raw).
- `summarize(text) → {id, cwd, model, createdAt, title, messageCount}` for listing: the same
  line walk with `JSON.parse` and the structural checks only (no zod per message). The full
  strict parse runs on `load` of the chosen session. Measured cost: 52 ms of `JSON.parse` for
  all 178 converted files vs 106 ms today (Q5).
- `segmentFromRecord(record, inc) → KnownLogEntry[]`: a laptop-minted segment
  (`inc = "laptop-<uuid>"`, `base{reason:"create"}`, one `message` per message, a `title`
  entry for a chosen title). Used by the in-process path (§5) and by asides of a held copy
  (§4). It mints only known types with their fixed `critical` values. No new type.

#### 3. Store `packages/daemon/src/session-log-store.ts` — `LogSessionStore` (laptop)

Same public surface the laptop uses today (`load`, `scan`, `list`, `latest`, `remove`,
`drain`), plus `write(update)` / `saveSnapshot(record)` / `saveAside(...)`. It keeps the
per-uid in-process queue (`session-store.ts:478-514`, same coalescing) and adds a
**per-session lock file** `.<uid>.lock` (hidden: never scanned) around every write and
remove. The lock is `wx`, its body `pid token ms`. A holder whose pid is dead or whose stamp
is older than 30 s is taken over (writes take ms; the age closes the pid-reuse hole of P8).
A live holder is waited for, with backoff, up to 2 s, then the save fails (reported by the
saver, retried at the next save). The token tells two store instances in ONE process apart
(tests; `findInOtherProjects` opens several).

`write(update)`, with `update = {id, meta: {cwd, model, createdAt}, entries, messages, read:
{from?, head, outcome}, aside?}` (P2's new fields). Under the lock:

0. If the session has only `<uid>.json` (not converted yet), or the `.jsonl` cannot be read
   (corrupt, unknown `schemaVersion`, unknown critical): REPLACE (step 3). The old file's
   bytes go aside first when they are not contained (FM 14, Q6).
1. Read the file's tail (the last complete line; read backwards until a `\n` is found, so
   one line of 8 MB still works). If the file does not end in `\n`, truncate the torn tail
   first (`ftruncate` to the last `\n`; measured above).
2. **APPEND** iff `read.outcome === "linear"` AND the file's last entry id equals this
   writer's remembered `lastDiskHead` AND `read.from` equals its remembered `lastFromHead`.
   One `write()` of all lines + `fsync` (Q9), `O_APPEND`. If the batch contains a
   `base{compact|context_reset}` and `keepSuperseded` is `false`, do a REWRITE to
   header + `entries[from that base]` instead (superseded by design; no aside: the owner's
   default = today's).
   **Same segment, other writer** (the common case with several TUIs): if the file's last
   segment `base.id` equals this writer's current segment's `base.id`, the ids are the same
   daemon's. If the file's head is inside this writer's segment, append only the entries
   after it. If the file is AHEAD (its head `seq` > this writer's), skip: the file already
   holds more of the same lineage (**fixes L3**: an older copy never overwrites a newer one).
3. **REPLACE** otherwise (a cold / rebased / reseed / adopt / fork read, a mismatch, a
   conversion). Parse the file (rare, O(file)). Write header + (kept superseded segments) +
   this writer's current segment, atomically (temp + fsync + rename, today's
   `writeAtomic` path). **Before dropping the file's last segment L**, it must be contained:
   - L's projection is a prefix of the new projection (per-message digests, `messageDigest`);
   - or L is the segment this writer's segment superseded by a compaction or reset in the SAME
     incarnation (`L.base.inc === mine.base.inc`, the reader's "one writer" rule,
     `session-log-reader.ts:216-218`); it is then kept or dropped per `keepSuperseded`;
   - else → **set L aside first** (its raw bytes, `<uid>.stale-<ms>-<hex>.aside`), then
     replace, plus a notice. This is the F1 rule on disk: never spliced, never silently
     lost. It **replaces the Q6 guard** (justification, §7 below).
   - L's lines of unknown non-critical types (written by a newer build) count as "not
     contained": the bytes go aside (Q2).
   - With `keepSuperseded: true`, the segments before L are carried over byte for byte.
     A seed / reload / create `base` RESTATES history (it is not a supersession), so it
     replaces L in place and never stacks a duplicate segment.
4. Remember `lastDiskHead` / `lastFromHead`. The writer's in-memory current segment is
   updated from EVERY read, written or not: a batch with a `base` → the segment restarts at
   the last `base`; otherwise the batch extends it.
5. Conversion end: after the `.jsonl` rename is durable, `<uid>.json` is deleted if its
   messages are a prefix of the written projection, else moved aside (Q6). A crash between
   the two leaves both: `load` prefers `.jsonl`, and the next write finishes the step.

`load(id)`: `.jsonl` → `parseLogFile` → record `{id, cwd, model, createdAt, updatedAt: mtime,
title, messages: closeAtLoad(fold(last))}`. Else `.json` → today's `parseSessionRecord`
(`session-store.ts:344-380`, reused as is). Same `LoadResult` shape (`ok` / `absent` /
`unreadable`), so `resolveResume`, `findInOtherProjects` and `readSessionRecord` keep their
logic. `scan`/`list` take `*.jsonl`, plus `*.json` with no `.jsonl` twin, via `summarize`.
`list()` returns records with `messages` only for the record that `load` returns. The picker
needs only `messageCount` (`session-resume.ts:132-139`), so `SessionChoice` gets it from the
summary. `remove(id)`: `.jsonl`, `.json`, asides, under the lock.

`saveAside(...)` (the F1 held copy from `ReadBack.aside`, `local-runtime.ts:365-372`): the
aside is a log file too (header + `segmentFromRecord`), same name (Q7). The ordering stays:
aside durable BEFORE the main file changes, a failure retried at the next save.

#### 4. Client: `ReadBack` gains where the read stood (no wire change)

`remote-client.ts:194-207` + `:1261-1267`: add `read: {from?: LogCursor, head: LogCursor,
outcome: LogOutcome}`. `from` = the `after` of the attempt that succeeded (absent when cold).
`head` = `applied.state.head`. `outcome` = `applied.outcome`. Nothing else in the client
changes. **No seeding of the client's log state from disk** (a resume or attach first reads
cold → REPLACE once, today's cost): see Notes/debt.

#### 5. CLI

- `persistingController` (`local-runtime.ts:328-475`): `persist(messages, title)` becomes
  `persist(back)` (the whole `ReadBack`). **Removed:** the save-time cut (`:377-395`:
  `closed`, `midTurn`, `lastMidTurnCount` `:356`), and `cutTurn`/`cut` (`:350`, `:556-558`) if
  grep confirms the cut was their only effect. `cutHistory` moves to `session-log-file.ts`
  (§2). `runningCalls` stays on `RemoteSession` (other readers: executor greps; else debt).
- `build`'s persist callback (`:750-765`) → `deps.saver.write({id, meta, ...back})`.
  `setAside` (`:771-782`) → `saver.saveAside(held, meta, title)` (log format).
- `SessionSaver` (`session-saver.ts`): `write(update)` with the same outcome handling as
  `save` (`:84-105`); `save(record)` remains for the in-process path → `saveSnapshot`.
  `observe` listeners get `{id}` (the kept index needs nothing else, P4).
- `openTuiSessions` (`tui-sessions.ts:64-76`): `new LogSessionStore(dir, {keepSuperseded,
  notify})`, so the Q6 `onAside` callback goes. `readSessionRecord` (`:137-146`) and
  `findInOtherProjects` (`session-projects.ts:33`) use `LogSessionStore.load`.
- In-process path (`main.ts:1686-1697`): `saver.save(record)` → `saveSnapshot(record)` =
  REPLACE with `segmentFromRecord`, whole file, as today. **The Q6 strict-prefix guard is kept
  for this path only**: there is no log to replace it, and P9 means a compaction cannot be
  told from a rewrite (Q10).
- Config: `sessions: {keepSuperseded?: boolean}` in `config/src/schema.ts`, resolved in
  `resolve.ts` / `load.ts` (default `false`), passed by `main.ts` and `relay.ts` to
  `openTuiSessions`. Laptop-only: never carried to a pod (`config-carry`).

#### 6. Removals, each justified

| Removed | Where | Why the log makes it unnecessary |
|---|---|---|
| Whole-record JSON rewrite per save (laptop) | `session-store.ts:516-551` via `tui-sessions.ts:68` | replaced by APPEND (one round's lines) / REPLACE (rare). `JsonSessionStore.save` stays for `serve` (task 3) |
| Q6 guard (`dropsHeld`, `onAside`) for the laptop | `session-store.ts:412-417`, `:425-436`, `:529-545`; `tui-sessions.ts:66-72` | Q6 caught only a STRICT-prefix stale copy. The writer's rule is stronger and exact: same-segment writers append or skip (an older copy never regresses the file, L3). Any other REPLACE sets aside every dropped segment that the new one does not contain (F1 on disk, which Q6 missed: the repro). Kept only for the in-process snapshot path (no log, P9) |
| Save-time cut + `lastMidTurnCount` | `local-runtime.ts:356`, `:377-395` | the disk holds the raw log, and `closeAtLoad` closes an open turn when it is read (P6, P7). `lastMidTurnCount` existed only so Q6 would not misfire on two cut copies (comment `:384-386`) |
| `cutTurn` / `cut` (if only the cut used them) | `local-runtime.ts:350`, `:556-558` + callers | a session ended under a running turn has no `turn_end` in its log → open at EOF → closed at load |
| `JsonSessionStore.saveAside` | `session-store.ts:453-476` | asides are written by `LogSessionStore` in the log format (Q7); the serve store never set any aside |
| Pretty JSON `null, 2` on the laptop | `session-store.ts:536` | compact JSONL lines (measured ×1.085 vs today's pretty JSON, envelopes included) |

#### 7. AGENTS §7 wording (rule change, on this branch; Q14)

Replace, in the persistence bullet, from "The daemon owns the live conversation; …" through
"…never rendering-only events (e.g. `steer`)." with:

> The daemon owns the live conversation; the main thread owns its on-disk store — one typed
> event log per session, `<uid>.jsonl` (a file header line, then `session/log` entries) — and
> persists its own copy from `session/log` reads at every committed round, turn end and
> compaction (offline viewing, `open{messages}` recovery). It writes only the entries the
> client VALIDATED and re-serialized (known types; a pod's unknown entries are dropped, never
> written). Every write to `<uid>.jsonl` holds the session's lock file (an aside is a new
> file, written outside it). A write that does not continue the file's last entry rewrites
> the current segment atomically, and any content it would drop that its own copy does not
> contain is set aside first (never spliced, never silently lost); a writer of the same
> segment appends only what the file lacks, or skips when the file is already ahead.
> A session cut mid-turn is closed when it is LOADED (from the log's turn markers), not when
> it is saved. Superseded history (compaction, `context_reset`) is kept only with
> `sessions.keepSuperseded` (default off). The main owns the session uid (passed into
> `session/open`) so `--resume` keeps the file. Persist only the conversation — `ChatMessage`s
> and the log's typed facts about them (turn/call markers, title, checkpoints) — never
> rendering-only events (e.g. `steer`).

and, in the "On-disk records are versioned separately" sub-bullet, replace "The laptop's
session store parser is strict. A newer build's record is rejected loudly by an older one,
never half-loaded." with:

> The laptop's log carries a header `schemaVersion` (an unknown one is refused, and the file
> is set aside, never overwritten). Inside it, an entry of an unknown type is refused if
> `critical` and skipped if not; its line is kept on append and set aside, never dropped, by a
> rewrite. What an older build cannot project, it refuses loudly; it never half-loads it.

(The `serve` part of the bullet is unchanged until task 3.)

### Files (dependency order; smallest diff)

1. `packages/protocol/src/session-log.ts`: the projection fold
   (`session-log-reader.ts:154-202`) moves here as one pure, node-free function
   (`foldEntries`), next to the entry schemas. Reason: `daemon` cannot import from `client`,
   and both ends must share ONE fold. This is a pure helper, NOT a wire change:
   schemas, `schema/protocol.json` and `PROTOCOL_VERSION` (17) are untouched.
   `packages/client/src/session-log-reader.ts`: calls `foldEntries` (no behaviour change;
   C1–C8 stay green). `packages/client/src/remote-client.ts`: `ReadBack.read`.
2. `packages/daemon/src/session-log-file.ts` (new, pure) + `packages/daemon/src/session-log-store.ts`
   (new, I/O) + `packages/daemon/src/index.ts` exports. `cutHistory` (+ its notes import)
   moves from `cli/src/local-runtime.ts` to `session-log-file.ts`.
3. `packages/config/src/schema.ts` / `resolve.ts` / `load.ts`: `sessions.keepSuperseded`.
4. `packages/cli/src/session-saver.ts`, `tui-sessions.ts`, `session-projects.ts`,
   `session-resume.ts` (`SessionChoice.messageCount` from the summary), `local-runtime.ts`
   (controller + `build`), `main.ts` (in-process `saveSnapshot`, config pass-through),
   `relay.ts` (config pass-through).
5. `packages/agent/src/session-store.ts`: drop `saveAside` and the `onAside`/Q6 code paths that
   only the laptop used. Keep `parseSessionRecord` (legacy read) and everything serve uses.
   Executor: if the in-process Q6 needs `dropsHeld`, export it rather than duplicate it.
6. Docs on this branch: this doc (`docs/feat/session-log-laptop-store.md`), AGENTS.md §7 (the
   text above), `CHANGELOG.md` `[Unreleased]`, `TODO.md` row; `docs/feat/session-log.md`
   Notes/debt gets a pointer line ("disk reader: task 2").

### Failure modes (each: how state converges)

| # | Case | Convergence |
|---|---|---|
| 1 | **Crash mid-append** | the last line is torn → ignored by load, truncated by the next writer before it appends. Complete lines of a partial batch are each a derivation step (a valid prefix); an open turn is closed at load. A torn compaction batch (`keepSuperseded: true`) → the incomplete last segment is dropped, the previous one is the projection |
| 2 | **Crash mid-REPLACE** | the rename is atomic: old file or new one. The temp leftover is swept (the sweep's pattern is extended to the new temp name) |
| 3 | **Crash between the `.jsonl` rename and the `.json` delete** | both exist; `load`/`list` prefer `.jsonl`; the next write deletes or sets aside the `.json` (step 5) |
| 4 | **Crash while holding the lock** | dead pid or a stamp > 30 s → taken over. Two processes taking over the same stale lock at once (the TOCTOU P8 documents) → at worst both append the same entries: the loader skips an exact duplicate id, and a same-segment writer's next write sees the file ahead and skips |
| 5 | **Lock held for long (hung FS)** | bounded wait 2 s → the save fails → one notice (`nextSaveState`), retried at the next save; `drain` lists it at exit |
| 6 | **Several TUIs of one detached run** (same daemon) | serialized by the lock; same segment → suffix append or skip; never a duplicate segment, never a regression (L3 fixed). Test W4 with a second PROCESS |
| 7 | **F1 on disk** (B appended D1's 49–50; A, reseeded on D2 from 48, writes) | A's REPLACE finds L (D1, …50) not a prefix of D2's projection and not the same inc → L's bytes aside + notice, then D2's segment. Never spliced |
| 8 | **Write fails (ENOSPC, EACCES)** | the saver's notice; the writer's in-memory segment still advanced; the next save's check mismatches → REPLACE from the segment: the file heals |
| 9 | **Persist skipped** (empty read `local-runtime.ts:373`, hand-over `:751`) | the same: the next write sees `from ≠ lastFromHead` → REPLACE |
| 10 | **Compaction / `context_reset` between reads** (linear batch with a `base`) | `false`: atomic rewrite to header + the new segment (small). `true`: one append (old tail + `base` + new messages) |
| 11 | **Two compactions behind** (`rebased` + `gap`) | `true`: the new segment is stacked after the last kept one, the middle one is absent (the daemon no longer had it; said in Notes). `false`: rewrite |
| 12 | **Fork** (`ReadBack.aside`) | the held copy goes aside FIRST (log format), then REPLACE (FM 7's check runs too) |
| 13 | **Resume / attach / reconnect** (cold read) | one REPLACE of the current segment (today's per-save cost, once). A resume's seed = the loaded (closed) projection, a superset of the raw disk (P6) → contained → no aside |
| 14 | **Unreadable file** (corrupt middle line, unknown `schemaVersion`, unknown critical type) | `load` → `unreadable` (loud, as today); `--resume <uid>` refuses to start, as today. A WRITE moves the bytes aside first, then REPLACEs, with a notice. Today's `writeAtomic` overwrote such a file silently (`session-store.ts:529-532`) |
| 15 | **Unknown non-critical lines** (a newer build wrote them) | skipped at load; untouched by APPEND; set aside by a REPLACE that would drop them (Q2) |
| 16 | **Hostile pod** | only `KnownLogEntry` values (F4, client-validated) reach `write`; the store stringifies those, never a frame. Lock, header, names and asides are laptop-made. A pod can still force a REPLACE by forging lineage (task 1 L1/L6 class, accepted); the file-level aside rule then keeps the laptop's previous segment |
| 17 | **Version skew (disk)** | an older build (pre-task 2) scans only `*.json`: a converted session is invisible to it (pre-public, one build; said in CHANGELOG). Writing a new `<uid>.json` next to a `.jsonl` → the newer build prefers `.jsonl` and treats the `.json` per step 5 (contained → deleted, else aside). Nothing is lost |
| 18 | **Huge single entry** (an 8 MB message line) | the tail read extends backwards until a `\n`; append is one write |
| 19 | **Listing with torn / converting files** | `summarize` ignores a torn tail; `.json` without a twin is listed via today's parser; unreadable → `skipped` (reported, as today) |
| 20 | **`remove(id)`** (deleted on another device) | `.jsonl`, `.json`, asides and the lock, in the per-uid queue (latest operation wins, as today) |
| 21 | **In-process path** | whole-file REPLACE per save (today's cost), Q6 kept there, `keepSuperseded` not applied (P9, Q10) |
| 22 | **Empty / header-only file** | never written (header and segment land in one rename); if found → `unreadable` "no segment" |
| 23 | **`/clear`** | a new uid, a new file; the old one is untouched |

### Tests (red first; existing seams)

Seams: the in-process daemon over `createChannelPair` (`SessionHost` + `Connection` +
`RemoteClient`, the `dial()` pattern of `client/test/context-reset.test.ts`), `GatedModel`
(`client/test/support/fakes.ts`), the cli fakes of `cli/test/local-runtime.test.ts`, temp dirs
under the test-env guard's `HOME`, a `Bun.spawn` child for the cross-process lock (W4).

**Red on `main` (the headline properties):**
- **W1 — the file mirrors the daemon** (`cli/test/session-log-store.test.ts`, run FIRST: it
  pins the load-bearing assumption). Scripted session: multi-round turn, a parallel group, a
  failed turn, a `contextUsage` annotation, a `/settings` head swap, a compaction, a
  `context_reset` mid-turn, a failed write (injected I/O) and a skipped persist. After EVERY
  save: `fold(parseLogFile(file))` deep-equals `back.messages`. Red on main: no `.jsonl`.
  **Mutations:** a fold without `replace` → fail; APPEND without the `lastDiskHead`/`lastFromHead`
  check → fail (at the injected failed write); not updating the segment on a skipped persist →
  fail.
- **W2 — append cost**: on a ~2 MB session, the save after one round writes only that
  round's lines (bytes ≤ round + markers + 1 KB) and keeps the inode (no rename). Red on main:
  2.1 MB, new inode (repro).
- **W5 — F1 on disk**: the repro's divergent writer → an aside file holds the replaced
  segment's bytes, plus a notice. Red on main: `asides=0` (repro).
- **W4 — several writers (L3)**: two store instances, one in a child process, interleave saves
  from one daemon. The file folds to the daemon's projection, has no duplicate ids, and an
  older writer never regresses it. Red on main: the older mid-turn copy overwrites the newer
  one (L3).

**Store / format (pure + I/O):** W3 torn tail (half line → ignored; next save truncates, then
appends; a corrupt MIDDLE line → unreadable). W6 `keepSuperseded` false/true across a
compaction and a reset: 1 vs 2 segments, the same projection, default `false` (config test).
W7 lazy conversion: a synthetic `.json` fixture loads as today's record; the first save writes
`.jsonl` and deletes the `.json` (contained) or sets it aside (not contained). W8 crash
between rename and delete (both files) → `.jsonl` wins, the `.json` is handled. W9 newer-build
lines: unknown non-critical skipped at load, kept on APPEND, aside on REPLACE; unknown
critical / unknown `schemaVersion` → unreadable, and a write sets the file aside, then
replaces it. W10 lock: stale (dead pid; old stamp) taken; live → bounded wait → failed save
reported; released on every error path. W11 `summarize` = full `load` for id / title /
`updatedAt` / `messageCount` on every fixture; picker order by mtime. W12 `closeAtLoad`
equivalence with today's save-time `cutHistory(back.messages, runningCalls)` on scripted
mid-turn reads (`call_started` → "Interrupted", the rest "Not run", tail user/tool → the
note, a closed turn untouched). **Mutation:** ignore `call_started` → fail. W13 `remove`
deletes all four kinds. W14 in-process `saveSnapshot`: a strict-prefix copy → aside (Q6
kept), a compaction → replace. W15 F4 at the boundary: a `ReadBack` whose entry carries an
extra field and an unknown type → the file holds neither.

**Existing tests** (22 files touch the store: `agent/test/session-store.test.ts`,
`cli/test/{local-runtime,tui-sessions,session-saver,session-resume,session-projects,relay,
attach-plain-resume,cut-labels,context-reset-e2e,main,…}.test.ts`): fixtures that WRITE
`<uid>.json` keep working (lazy read). Assertions that READ the saved file switch to one
helper (`readSaved(dir, uid)` = `LogSessionStore.load`). Task 1's I5 ("the record equals
today's") is replaced by W1 + W12. The Q6 tests move to the in-process path (W14). Edited,
never weakened: each re-pointed assertion keeps its property (§9).

**Acceptance (owner's real store, read-only):** copy `~/.config/tentacle/sessions` into
`.tentacle/tmp/session-log-laptop-store/copy/` (gitignored; delete after). Then: (a) `list()`
before conversion (all `.json`, today's path) and after converting every file (`write` of a
cold read equivalent), gate ≤ 1.25 × today's 106 ms; (b) every converted file loads to
exactly its JSON record's messages (178/178); (c) sizes after conversion (expect ×1.085).

**Gate:** `bun run check` (typecheck → lint 0/0 → test; opt-in skips only), AGENTS §6.

### Owner questions (all at once; each with a recommendation and one plain line)

1. **Size: L, one task (not M)?** — **Yes, one L.** *It is a new store with crash, lock and
   conversion rules plus ~22 test files to re-point; splitting off `keepSuperseded: true`
   saves only ~15 % and adds a cycle.*
2. **Unknown non-critical lines in a file a newer build wrote: skip them when loading, keep
   them on append, set their bytes aside if a rewrite would drop them?** — **Yes.** *The
   session still opens, and nothing a newer build wrote is ever lost.*
3. **Line 1 is a file header (id, cwd, model, createdAt, `schemaVersion`), not a log entry, so
   it has no `type` and no `critical` value?** — **Yes.** *It avoids adding an entry type
   (your rule) and gives the file its own version number.*
4. **`updatedAt` = the file's modification time?** — **Yes.** *Every save touches the file,
   and listing then needs no read.*
5. **Listing reads every log quickly (plain JSON parse, no full validation) instead of keeping
   a separate index file; add an index only if listing exceeds 250 ms on your store?** —
   **Yes.** *Measured ~60–70 ms vs today's 106 ms; an index is a second file that can go out
   of sync.*
6. **A converted `<uid>.json`: delete it once the log is safely written AND contains it;
   otherwise move it aside?** — **Yes.** *No duplicates on disk, and nothing is lost when the
   two differ.*
7. **Aside files use the log format too (same `.stale-….aside` name)?** — **Yes.** *One
   format everywhere; the JSON writer leaves the laptop entirely.*
8. **Several writers: a small lock file per session around every write; writers on the same
   daemon append only what is missing, or skip?** — **Yes.** *Two terminals of one detached
   run can no longer overwrite each other (L3).*
9. **`fsync` after every append, plain `fsync` (no `F_FULLFSYNC`), same as today?** —
   **Yes.** *Measured 0.08 ms per save; same safety level as now.*
10. **The `--in-process` fallback keeps whole-file saves and the old "shorter copy goes
    aside" guard, and ignores `keepSuperseded`?** — **Yes.** *That path has no daemon log,
    so it cannot tell a compaction from a rewrite.*
11. **Close a cut turn at LOAD (open turn at the end of the file → "Interrupted" / "Not run" /
    the ended-turn note, as today), and never at save?** — **Yes.** *The file keeps the raw
    truth; what you resume is exactly what you get today.*
12. **`keepSuperseded: true` only KEEPS the old segments in this task (no viewer yet; resume
    shows the current one)?** — **Yes.** *The data is safe now; a viewer is a separate
    small task.*
13. **On disk, check `seq` order and skip exact duplicates, but do not re-check the `prev`
    links (task 1 review L2)?** — **Yes.** *Unknown entries dropped in transit leave
    harmless holes in the links; the writer guarantees continuity.*
14. **Approve the exact new §7 wording above (persistence bullet + on-disk sub-bullet)?** —
    **Yes.** *It describes the code this branch lands, no more.*

### Notes / debt (deliberate)

- **No seeding of the client's log state from disk.** A resume, attach or reconnect does one
  cold read and one REPLACE: today's cost, once per open. Seeding (`entry.log` from the file,
  so an attach to a live daemon would read incrementally) is a client change with its own
  lineage rules. Follow-up only if attach cost matters.
- **A superseded segment two compactions back** (FM 11) is absent from a `keepSuperseded`
  file when the laptop missed it (the daemon no longer retained it). The `base` reason
  shows the jump; no marker is invented (a new type would be an owner decision).
- **Viewer for kept segments**: not here (Q12).
- **`runningCalls`** on `RemoteSession`: kept if anything else reads it, else removed in a
  follow-up.
- **No directory `fsync` after rename**: parity with today (`session-store.ts:536-537`).
- The disk format is the shared truth for task 3 (`session-log-file.ts` in `daemon`).

## Execution

*— claude-opus-5-5, 2026-11-07*

**Result: done**, on `feat/session-log-laptop-store` off `be2ef89`, uncommitted (the
orchestrator commits). Gate (once, at the end): `bunx tsc --noEmit` clean ·
`bunx biome check .` 0 errors / 0 warnings (730 files) · `bun test packages` **5424 pass,
3 skip (the opt-in live-k8s / live-docker / slow-socket), 0 fail**. No wire change:
`PROTOCOL_VERSION` stays 17, `schema/protocol.json` untouched, `LOG_ENTRY_CRITICAL`
untouched (no entry type added, no `critical` value changed).

### As built, in order

1. **W1 first (load-bearing assumption) — HOLDS.**
   `packages/cli/test/session-log-store.test.ts`: a real `SessionHost` + `Connection`, the
   laptop's `createLocalRuntime`, the saver `openTuiSessions` builds. Script: a multi-round
   turn with a parallel group, `contextUsage` annotations (`replace` entries, asserted
   present), a failed WRITE (the `.jsonl` made read-only for one save: "not saved" then
   "saved again", asserted), a failed TURN (`closeFailedTurn`), a compaction, a
   `context_reset` mid-turn. After every turn the file's last segment equals the daemon's
   segment entry for entry (key-order-insensitive: the client re-serializes in its schema
   order), the folds are equal, and the store's own `load` equals the daemon's projection;
   at quiescent points inside a turn the file is a prefix of the daemon's segment.
   **Red on `be2ef89`, on the assertion**: `mismatches` = 7× "no file" (no `.jsonl`).
   Mutations (each killed): M1 the shared fold without `replace` → "the store's load is not
   the daemon's projection" ×3; M2 APPEND without the continuation check → the file is
   spliced and refused at load ("replace at 15 past the end (10)"); M3 the writer's segment
   rolled back on a failed write → the healing REPLACE writes a hole, same refusal.
2. **Protocol** — `projectEntry` (`packages/protocol/src/session-log.ts`): the projection
   step of one entry, generic over the list item. The client reader
   (`client/src/session-log-reader.ts`) applies it to both its message and digest lists
   (all client tests green, no behaviour change). **Client** — `ReadBack.read
   {from?, head, outcome}` (`remote-client.ts`).
3. **Daemon** — `session-log-file.ts` (pure: header, `parseLogFile` strict/lax,
   `closeAtLoad`, `cutHistory` moved here from `cli/local-runtime.ts`,
   `segmentFromMessages`, `headerLine`/`entryLines`) and `session-log-store.ts`
   (`LogSessionStore`: per-uid queue, `.<uid>.lock`, APPEND / same-segment suffix append /
   skip-when-ahead / REPLACE with the containment-or-aside rule, `saveSnapshot`,
   `saveAside`, `load`, `summarize`, `list`, `loadAll`, `remove`, sweep of dead temps and
   locks); exported from `@tentacle/daemon`.
4. **Config** — `sessions: {keepSuperseded?}` (`config/src/schema.ts`, `resolve.ts`,
   `load.ts`, the commented template in `defaults.ts`), passed by `main.ts` (both
   `openTuiSessions`) and `relay.ts`. Laptop-only (never in `sessionSettings`).
5. **CLI** — `SessionSaver.write(LogWrite)` / `save(record)` → `saveSnapshot` /
   `saveAside(id, meta, messages, title)`; observers get `{id}`. `openTuiSessions` builds
   a `LogSessionStore` (`where.keepSuperseded`, `onAside` → notice); `readSessionRecord`
   and `findInOtherProjects` load through it; `resolveResume` lists summaries and LOADS
   the chosen one (strict). `persistingController`: the save-time cut, `cut`,
   `cutTurn()` and `lastMidTurnCount` removed; every read is handed on raw with the whole
   `ReadBack`; `build` writes `{id, meta, entries, messages, read}`.
6. **Agent** — `JsonSessionStore` (now `serve`-only): `saveAside`, `onAside`/`AsideInfo`,
   `dropsHeld` and the aside sweep removed.
7. **Tests re-pointed** (edited, never replaced): 21 cli test files (+ the agent store test) from
   `JsonSessionStore` to `LogSessionStore`; fixtures write logs via
   `test/session-fixture.ts` (`saveSnapshot` + mtime = `updatedAt`); reads of saved files
   via `loadAll()`/`load`; corrupt fixtures are `.jsonl`; string ("auto") fixture titles
   became chosen titles or derivable contents (a log derives an auto title). Behaviour
   assertions that pinned the removed save-time cut now pin raw-at-save; the close is
   pinned at load (W12 and the existing Q2 e2e tests, which pass unchanged through
   load-time closing). The agent Q6 block moved to the log store tests.
8. **New tests**: `daemon/test/session-log-file.test.ts` (15), `daemon/test/session-log-store.test.ts`
   (18, incl. a second writer PROCESS via `test/fixtures/log-writer.ts`), cli W1 + W15 +
   `/clear`.
9. **Docs**: AGENTS §7 (both texts, as approved, minus the legacy sentence), CHANGELOG
   `[Unreleased] → Changed`, README (where sessions live, the key), `TODO.md` row,
   `docs/feat/session-log.md` Notes/debt pointer.

### Drift from the Implementation (and why)

- **Owner amendments** (above): no legacy JSON; in-process writes the `.jsonl`. W7/W8/Q6
  not written; a test pins that a legacy `.json` is ignored silently (W11).
- **The Implementation was updated after coding, not before** (the amendments block):
  my process slip; the code follows the amendments.
- **APPEND rule**: the plan's pair (`lastDiskHead`, `lastFromHead`) is kept for the
  F4-dropped-head case, and a simpler primary rule added: append iff the read is linear
  and the file's last entry id = `read.from.id`. Same safety (ids are unique per
  incarnation), fewer REPLACEs.
- **Bug found by W4 (two writers)**: after a "file ahead → skip", remembering the file's
  head as `lastDiskHead` made the pair rule re-append entries already there (67
  duplicates in the 2-process run). Fixed: the skip forgets the pair. M4 = that bug.
- **Bug found by the re-pointed Q2 tests**: the controller skipped EMPTY reads (`messages
  .length > 0`), so the store never saw the cold segment and the later linear reads had
  nothing to write from ("no complete log segment"). Every read is now handed on; the
  store writes no file for an empty history. M11 = that bug. (FM 9 in practice.)
- **A fork's double aside**: the held copy (`saveAside`) and then the REPLACE's own
  containment check both set the same content aside. The store remembers the copy it
  just set aside and counts it as containing (one aside, test + M13).
- **`list()` returns summaries** (`SessionSummary`, lax parse); `loadAll()` (strict, all
  files) added for tests and audits.
- **D7 / "stopped, then /quit"**: the stopped turn has its `turn_end`, so it loads raw
  (`[user, assistant, tool]`); the old save-time cut also appended "the session was
  ended…" because the quit cut every read. Per Q11 ("a closed turn stays raw"). The
  quit-cut of a RUNNING turn is unchanged (closed at load, the Q2 tests pass).
- **Q6 property (two in-process writers)**: the stale shorter copy now replaces the file
  and the longer one goes aside (before: the file kept, the copy aside). Nothing is lost
  either way; the rule is the same §7 rule everywhere (`tui-sessions.test.ts`).
- `RemoteSession.runningCalls` kept (its own client tests read it): debt.
- Red-first: W1 red on `be2ef89` on its assertion. The store/format tests exercise new
  modules (red on main = import), so their non-vacuity is shown by mutation instead:
  **M1–M15, all killed** (M4–M14 by `.tentacle/tmp/session-log-laptop-store/mutate.ts`, M15 =
  the client passing the raw page entries → W15 fails), each restored from a `cp` backup,
  `shasum -c` OK. M14 first SURVIVED (ids sorted alike by name and mtime) → the test's ids
  were fixed, then killed.

### Measurements

- **Listing** (synthetic store, 200 logs, 48.7 MB, long-tailed sizes; `listing.ts` in the
  scratch folder): `list()` min 35.0 / **median 36.9** / max 42.1 ms (gate 250 ms; today's
  JSON listing of the real store was 106 ms). No index file needed (Q5).
- **Append cost** (W2): a round on a ~2 MB session writes exactly its own lines, 0
  rewrites, same inode (today: 2.1 MB rewritten, new inode — the Context repro).
- `connect`: `packages/cli/src/connect.ts` has 0 references to a saver / store / readBack
  / `.jsonl` — it still keeps no laptop copy.

### Unverified (and how to verify)

- Real pod `run`/`attach` and two real terminals of one detached run: covered only by the
  in-process daemon + a second writer process. Verify with the owner checklist.
- `tsc -p apps/mobile` (the second half of `bun run typecheck`) not run here (not part of
  the asked gate; mobile imports only `@tentacle/protocol`, which gained one pure function).
- Linux/overlayfs fsync behaviour (task 3's measurement).

### Owner live checklist

1. `rm -rf ~/.config/tentacle/sessions` (old `.json` are no longer read), start `tentacle`,
   two turns with tools → `ls ~/.config/tentacle/sessions/*/` shows one `<uid>.jsonl`;
   `tail -3` of it shows the last round's `message` / `turn_end` lines.
2. Quit, `tentacle --resume` → the picker lists it with its title; resuming shows the
   history.
3. `run --detach`, attach from TWO terminals, one turn each → one `.jsonl`, no
   `.aside`, `tentacle --resume <uid>` shows both turns.
4. Kill a TUI (`kill -9`) mid-tool, `--resume` → the call reads "Interrupted …".
5. With `"sessions": {"keepSuperseded": true}`: `/compact` → the file holds two `"type":"base"`
   lines; resume shows the compacted context.
6. `/clear` → a second `.jsonl`; the first is unchanged.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-08*

Fixes the review's findings (REQUEST-CHANGES, HEAD `e1af680`) under the orchestrator answers.
Only `packages/daemon/src/session-log-store.ts` changed in `src/` (plus AGENTS §7 and this
doc). No `critical` value or `LOG_ENTRY_CRITICAL` touched, `PROTOCOL_VERSION` untouched.

**As built**
- **M1** (`replace`): the file's last segment of the SAME daemon (`inc`) with a larger
  `base.seq` than this writer's → skip ("file ahead"), like the same-`base` case; the writer
  forgets its remembered pair so a later read is matched by id.
- **M2**: the torn-tail truncate on the "unknown lines after the last known one" append path
  uses BYTE offsets (`Buffer.byteLength`), like the `readTail` paths.
- **Answer 3 / L3b**: `replace` and `saveSnapshot` always carry the segments before the file's
  last one (kept earlier with `keepSuperseded: true`) over, whatever the option says now.
- **L3a**: the continuing compaction/reset rewrite (option off) now goes through `replace`
  (it reads the file) instead of writing blind; `settleLast` sets the superseded segment's
  bytes aside when it holds unknown non-critical lines (with the option on the segment is
  kept as it is). `saveSnapshot` also sets aside its own earlier segment if it holds unknown
  lines.
- **L1**: an empty/unparsable lock body is LIVE until the lock's mtime is older than
  `lockStaleMs`; the busy message omits the pid then.
- **L2**: AGENTS §7 and the §7 text above: "every write to `<uid>.jsonl` holds the lock (an
  aside is a new file, written outside it)" and "a writer of the same segment appends only
  what the file lacks, or skips when the file is already ahead".
- L4 / answer 4: accepted as is (no change).

**Tests** (extending `packages/daemon/test/session-log-store.test.ts`, `describe("fix round 1")`,
7 tests). **Red on `e1af680`**, each on its property: M1 ×2 (keepSuperseded false/true: the
file regressed to "first prompt"), M2 (`line 4 is not JSON`), L3 kept-segments (a segment
missing), L3 snapshot (1 segment, expected 2), L3a (0 asides, expected 1), L1 (the save did
not fail on an empty/garbage lock). Green after: store + file tests 40/40.

**Mutations** (cp backup → mutate → test → restore; `shasum -c` OK), one per behaviour, all
KILLED: F1 no "ahead" skip (M1 ×2) · F2 char offsets (M2) · F3 replace drops kept segments ·
F4 saveSnapshot drops kept segments · F5 no aside for unknown lines of a superseded segment ·
F6 unparsable lock body stale at once. Driver: `mutate-fix1.ts` (scratch).

**Reviewer repros, new output** — `r1-utf8-torn.ts`:
```
parse after write: ok, 2 messages, unknown=1
load: "ok"
aside files: 0
```
`r2-older-writer.ts` (option off, and `keep`; both identical):
```
after A: [{"role":"user","content":"SUMMARY"},{"role":"user","content":"prompt AFTER compaction"}]
after B: [{"role":"user","content":"SUMMARY"},{"role":"user","content":"prompt AFTER compaction"}]
asides: 0
```

**Gate** (once, at the end): `bunx tsc --noEmit` clean · `bunx biome check .` 730 files, 0/0 ·
`bun test packages` **5431 pass, 3 skip (the opt-in ones), 0 fail**. `tsc -p apps/mobile` not run.

**Unverified**: M1's skip assumes a larger `base.seq` of the same `inc` means a newer segment
(true for one daemon's monotonic seq); a pod forging `inc` and `seq` can only make a writer
skip a save, not lose file content (the next honest read replaces from its own segment).

## Review

*— claude-opus-5-5, 2026-11-08* (fresh context; **same model as the executor** — shared blind
spots can survive both passes; a load-bearing task would ideally get a different-model pass too)

**Verdict: REQUEST-CHANGES** — two MEDIUM findings, both on the "never silently lost" promise of
the new §7 text; everything else holds.

**Gate** (commit `70afac3`): `bunx tsc --noEmit` clean · `bunx biome check .` 730 files, 0/0 ·
`bun test packages` run twice: **5424 pass, 3 skip (the opt-in ones), 0 fail** both times
(164.4 s / 164.0 s). `tsc -p apps/mobile` not run (not in the asked gate).

### Findings

**M1 (MEDIUM) — an older writer of the same daemon regresses the file after a compaction, with no
aside.** `packages/daemon/src/session-log-store.ts:578-590` (`settleLast`): `sameInc` counts as
"contained" in both directions. When the file's last segment is NEWER than the writer's (same
`inc`, a later `base`), it is dropped and the older segment replaces it. The "file ahead → skip"
check (`:528`) only covers the SAME `base` id. Scenario (two TUIs of one detached run): B reads
round N; the user compacts; A reads (round N+1 + the `compact` base + a new prompt) and saves
first; B's older save lands after it. Repro `review/r2-older-writer.ts`, with
`keepSuperseded` false AND true:
```
after A: [{"role":"user","content":"SUMMARY"},{"role":"user","content":"prompt AFTER compaction"}]
after B: [{"role":"user","content":"first prompt"},{"role":"assistant","content":"first answer"}]
asides: 0
```
The next save of either writer heals the file. A crash of both, or the last save of a `--rm` run
whose save is "confirmed", inside that window loses the post-compaction messages silently. This is
the L3 class the task says it fixed. No test covers it (the suite is green with the bug).
Fix: same `inc` and `last.base.seq > mine.seq` → skip like `:528` (the file is ahead), plus a
test.

**M2 (MEDIUM) — a torn tail is truncated at a CHAR offset on one append path.**
`session-log-store.ts:543-546` passes `size: text.length, contentEnd: parsed.contentEnd` (UTF-16
code units of the decoded text) to `appendLines`, which calls `truncate(path, contentEnd)` (bytes).
The other append paths use `readTail`'s byte offsets and are fine. You reach this path when the
file's last line is an unknown non-critical entry (written by a newer build) and there is also a
torn tail. With any non-ASCII content (Italian accents are enough), the truncate cuts into valid
lines. Repro `review/r1-utf8-torn.ts`:
```
parse after write: REFUSED: line 4 is not JSON          (ASCII control r1b: ok, 2 messages, unknown=1)
{"type":"future_note","seq":3,"{"type":"message","seq":4,…
```
The newer build's line is destroyed, and the session is `unreadable` until the next write sets it
aside. Not reachable today (no build writes an unknown type yet). It is the forward-compat path
that §7 now promises ("kept on append"). Fix: byte offsets (`Buffer.byteLength` / re-use
`readTail`), plus a non-ASCII test.

**L1 (LOW) — empty-body lock race.** `session-log-store.ts:719-753`: a live holder between
`open(wx)` and `writeFile(body)` has an empty file. A waiter reads it as pid `NaN` → stale → `rm`
→ two holders. The window is tiny and it converges (exact duplicates skipped, the next save's tail
check heals), but it opens exactly under contention. Fix: an empty or unparsable body counts as
live until the lock's mtime is older than `lockStaleMs`.

**L2 (LOW) — §7 wording is slightly broader and narrower than the code.** "Every write holds the
session's lock file": `saveAside` (`:303-323`) writes a new aside without it (harmless: it never
touches `<uid>.jsonl`). "A write that does not continue the file's last entry rewrites the current
segment": the code may also append only the missing suffix (`:461-471`, `:537-551`) or skip when
the file is ahead (`:528`). Suggested addition: "…; a writer of the same segment appends only what
the file lacks, or skips when the file is already ahead".

**L3 (LOW) — two silent drops on rewrite paths.** (a) The continuing compaction rewrite
(`:449-455`, `keepSuperseded` off) drops the superseded segment's unknown non-critical lines
without an aside. §7 now says such lines are "set aside, never dropped, by a rewrite". This needs
two builds writing one file at the same time. (b) Segments kept with `keepSuperseded: true` are
dropped with no aside by a later replace with the option off (`:553-555`), or by `--in-process`
`saveSnapshot` (`:606-649`). See owner question 3.

**L4 (LOW, drift the executor disclosed) — "stopped, then /quit".** The stopped turn has its
`turn_end`, so it now loads raw. On `main` the quit cut also appended the ended-turn note when the
tail was a prompt or a tool result. The visible result differs from `main` in that one case
(interrupted / not-run labels for a RUNNING turn cut by the quit are unchanged: Q2 e2e tests
green). See owner question 4.

### Attacks tried
1. **Crash mid-append, real SIGKILL** (`review/r4-crash.ts` (a), 8 kills of a child appending
   300 KB lines): 0 torn tails (a single `write(2)` completes under SIGKILL). The file always
   loads, and the next write continues with 0 duplicates. A synthetic torn tail split inside a
   multi-byte char (b): load ignores it (`torn=94`), and the continuing write truncates at the
   right byte and appends → **holds** (the main paths use `readTail` bytes; M2 is the one
   exception).
2. **Crash mid-replace**: a dead temp `.<uid>.jsonl.tmp-999999-…` is swept by a new store's first
   write (r4 (c)). Temp + `fsync` + `rename` → old or new → **holds** (no dir fsync: parity,
   noted).
3. **Lock** (`review/r3-lock.ts`): live holder → fails after 2000 ms with a clear message, lock
   left alone. Dead pid / 31 s stamp / empty body → taken at once → **holds** (L1 is the
   empty-body side of it). No await on the turn path: `persist` → `SessionSaver.write` is
   fire-and-forget (`local-runtime.ts` `build`). No lock or await reaches a `Connection` handler
   → §7 "don't serialize the RPC peer" **holds**.
4. **Several writers, older read lands last** (r2) → **M1**.
5. **Forward-compat append with non-ASCII + torn tail** (r1) → **M2**.
6. **F4**: `ReadBack.entries` = `applied.entries` (known types, zod-stripped, re-serialized);
   the store stringifies only those. W15 + the executor's M15 → **holds**. Pod-forged lineage
   forcing a REPLACE: accepted class, the aside rule keeps the previous segment.
7. **Critical table (item 14)**: `LOG_ENTRY_CRITICAL` untouched (the diff only adds
   `projectEntry`). `segmentFromMessages` mints only `base`/`message` (`critical: true`, as the
   table says) and `title` (no `critical`) → **no new or changed value**. `PROTOCOL_VERSION`
   untouched.
8. **Legacy / listing / connect**: `ids()` takes only `*.jsonl` (not hidden). `remove` never
   touches `.json`. `JsonSessionStore` is referenced only by `serve.ts`. `connect.ts`: 0
   references to a saver / readBack / store / `jsonl`. `updatedAt` = `mtime` in `load` and
   `summarize`. `record.model` is never read by the CLI, so the immutable header model is harmless
   → **holds**.

### Mutations (cp backup → mutate → test → restore; `shasum -c` OK at the end)
- E1 = executor M4 (skip remembers the file head): **killed**, W4 ×2 (in-process + second
  process).
- E2 = executor M6 (`keepSuperseded` ignored on a linear batch with a base): **killed**, W6.
- R1 = mine, the most load-bearing line (`settleLast` containment forced true → never set aside):
  **killed**, W5 (F1 on disk) + W13.
- Red on `main`: the new store/format tests are red by import there (modules absent). The
  executor's assertion-level red for W1 on `be2ef89` was not re-run here.

### Premise spot-check
P5 (aside names), P7 (`call_started` = `runningCalls` source), P10 (package deps), P11 (no
`sessions` key before): TRUE on `be2ef89`/HEAD. The Context repro is not re-run (the owner
amendments removed its JSON half). Its divergent-copy claim is re-tested on the new code by W5.

### What holds
The format (header non-entry, strict/lax parse, torn tail, exact-duplicate skip, unknown
critical/version → refused, and a write sets the file aside first). The shared fold
(`projectEntry`, the client unchanged in behaviour). Close-at-load. Append cost. The lock basics.
F4. Config default `false`. Docs pointers.

### How the executor behaved
Thorough and honest. Drift is disclosed, bugs found by its own tests are recorded (W4 duplicates,
empty reads), 15 mutations were run, and its own process slip was admitted (the amendments were
written after coding). Its blind spot is the one shared with this reviewer's model: the
several-writers analysis covered the same-`base` case and not a same-`inc`, newer-`base` file (M1).
The forward-compat append path was not tested with non-ASCII (M2).

### Owner questions (all at once; each with a recommendation and one plain line)
1. **M1: when the file already holds a NEWER segment of the same daemon, should the older writer
   skip instead of rewriting?** — **Yes.** *Two terminals: the one that is behind must never
   overwrite the one that is ahead, even right after a /compact.*
2. **M2: compute the torn-tail cut in bytes on every path?** — **Yes.** *A file with accented
   letters must never get cut in the wrong place after a crash.*
3. **Once old segments have been kept (`keepSuperseded: true`), should they survive turning the
   option off or a `--in-process` save?** — **Yes, carry them over (never delete kept history
   silently).** *Switching the option off stops keeping NEW old history. It does not erase what is
   already saved.*
4. **A turn you stopped yourself, then `/quit`: resume shows it as it was (no "the session was
   ended…" note), unlike `main`?** — **Yes, accept.** *You closed that turn yourself, so there is
   nothing to explain on resume.*
5. **§7 wording: add "a writer of the same segment appends only what the file lacks, or skips when
   the file is ahead" (L2)?** — **Yes.** *The rule then says exactly what the code does.*

### Orchestrator answers to the review (2026-11-08, owner asleep — decided overnight under the owner's delegation, to be confirmed in the morning report)
1. M1 — **Yes**: same daemon (`inc`) and the file's last segment is newer → skip, like the same-`base` case. Test with `keepSuperseded` false and true.
2. M2 — **Yes**: byte offsets on every truncate path, plus a non-ASCII test.
3. Kept segments — **Yes, carry them over**: turning `keepSuperseded` off, or an `--in-process` save, never drops segments already kept; L3(a) too: the unknown non-critical lines of a superseded segment are set aside, not dropped.
4. Stopped turn then `/quit` — **Yes, accept** the drift (no ended-turn note).
5. §7 wording — **Yes**, add the L2 sentence; also say `saveAside` writes outside the lock (it never touches `<uid>.jsonl`).
L1 (empty-body lock) — fix as suggested: an empty/unparsable body counts as live until the lock's mtime is older than `lockStaleMs`.
No `critical` value is added or changed by these answers.

## Task 3 sketch — `feat/session-log-serve-store`

*— claude-opus-5-5, 2026-11-07*

**Type:** feat · **Size:** L (M–L in the decision; the daemon record carries mutable state the
log does not, see below) · **Blast:** load-bearing (§7 daemon-side persistence, steering
window, archive, suspended-turn resume, `DAEMON_RECORD_VERSION`).

**What changes.** The `serve` store (`<configDir>/daemon/<projectKey(cwd)>/`, today's
`JsonSessionStore` via `serve.ts:122` and `daemon/src/session-persister.ts`) uses the same
`<uid>.jsonl` format and `session-log-file.ts`. The daemon is a TRUSTED writer of its OWN
entries (the `SessionLog` it already derives): no client in between. `schedule` stays
synchronous (capture the entries after the last persisted `seq`), and the append happens
off the steering window, never awaited (§7). The store lock (`acquireStoreLock`) already
makes serve a single writer, so it needs no per-session lock.
- **Lineage across reloads** (task 1 Q12): a reload starts `base{reload}` with `prev` = the
  stored head, so a laptop on `connect` (none today) or a resumed reader continues the chain.
- **State the log does not hold.** The daemon record also carries `turns`, `enqueueIds`,
  `turn{steering, pending permissions, inFlight}`, `returned`, `lastActiveAt`, `archivedAt`
  and `head` (`persisted-session.ts:102-141`). Options: (a) a small `<uid>.state.json` next to
  the log, rewritten atomically, naming the log head it matches; (b) new entry types →
  **each one needs an owner decision on `critical`**. Recommend (a): no new type, and the
  state is small.
- **Archive**: `archivedAt` and `reopen` live in the state file (a header line cannot be
  updated). The archive index (metadata only) = header + state file + mtime.
- **Suspended-turn resume** ("pending on disk ⇒ never started") reads the state file. The
  open turn at EOF uses the same `closeAtLoad` rule as the laptop.
- Lazy conversion of existing daemon records (`schemaVersion` ≤ 8 → log + state at the next
  persist); `DAEMON_RECORD_VERSION` 8 → 9 for the state file.
- `keepSuperseded` applies to serve too (the same config key).

**Measure FIRST, on Linux** (ext4 and overlayfs: a host and a container on the cluster;
script = this task's `fsync-bench.ts`, extended):
1. append 3 KB + `fsync` vs `fdatasync` vs none; temp + fsync + rename of 2 MB (today's per
   persist);
2. directory `fsync` after rename (Linux needs it for rename durability; macOS parity did not);
3. `O_APPEND` integrity under Bun's async `FileHandle.write` with 4–8 concurrent writers and
   lines up to 8 MB (the eval tested only `writeSync`, only on APFS). It is informational,
   since serve has a single writer, but it decides whether the state file and the log can
   ever be written by two processes;
4. torn-tail recovery after `kill -9` mid-append (a loop of 1 000).
Gate for the design: append + fsync p99 < 5 ms on the cluster disk; otherwise batch the
appends per committed boundary (already the natural unit).

**Size estimate:** L (one new state file and its version, the persister's capture, archive
and suspended-turn rewiring, conversion, and the tests in `daemon/test/persistence.test.ts`
and the serve tests). Could split if Review finds it illegible: 3a log + state file +
conversion, 3b archive/reopen + lineage across reloads.

## Appendix — scripts (gitignored scratch, pasted per AGENTS §6)

All in `.tentacle/tmp/session-log-laptop-store/`. `repro.ts` is pasted in Context.

`survey.ts` (read-only):

```ts
// Survey (read-only) of the real laptop store: file kinds, sizes, full-parse listing cost.
// Usage: bun survey.ts [root]   (default ~/.config/tentacle/sessions)
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? join(homedir(), ".config/tentacle/sessions");
const kinds = new Map<string, number>();
const sizes: number[] = [];
const files: string[] = [];
let dirs = 0;
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) {
    kinds.set(`(root) ${d.name.split(".").pop()}`, (kinds.get(`(root) ${d.name.split(".").pop()}`) ?? 0) + 1);
    continue;
  }
  dirs++;
  for (const name of readdirSync(join(root, d.name))) {
    const ext = name.endsWith(".aside") ? "aside" : name.startsWith(".") ? "temp" : name.split(".").pop() ?? "";
    kinds.set(ext, (kinds.get(ext) ?? 0) + 1);
    if (name.endsWith(".json") && !name.startsWith(".")) {
      const p = join(root, d.name, name);
      sizes.push(statSync(p).size);
      files.push(p);
    }
  }
}
sizes.sort((a, b) => a - b);
const total = sizes.reduce((a, b) => a + b, 0);
const q = (f: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * f))];
console.log(`project dirs=${dirs} kinds=${JSON.stringify(Object.fromEntries(kinds))}`);
console.log(`json records n=${sizes.length} total=${(total / 1e6).toFixed(1)} MB median=${q(0.5)} p90=${q(0.9)} max=${sizes.at(-1)}`);

let t0 = performance.now();
let msgs = 0;
const keys = new Set<string>();
for (const p of files) {
  const r = JSON.parse(readFileSync(p, "utf8"));
  msgs += r.messages.length;
  for (const k of Object.keys(r)) keys.add(k);
}
console.log(`full parse of all records: ${(performance.now() - t0).toFixed(1)} ms, messages=${msgs}, top-level keys=${[...keys].join(",")}`);

t0 = performance.now();
for (const p of files) {
  statSync(p);
  const fd = Bun.file(p).slice(0, 4096);
  await fd.text();
}
console.log(`stat + first 4 KB of each: ${(performance.now() - t0).toFixed(1)} ms`);
```
```
project dirs=28 kinds={"json":178}
json records n=178 total=34.7 MB median=67514 p90=558372 max=1444196
full parse of all records: 106.3 ms, messages=26156, top-level keys=id,cwd,model,createdAt,updatedAt,title,messages
stat + first 4 KB of each: 7.4 ms
```

`fsync-bench.ts`:

```ts
// APFS cost per save: today's whole-record write (temp + fsync + rename) vs a JSONL append
// (+ fsync / F_FULLFSYNC-free), and torn-tail recovery. Scratch only (this folder).
// Usage: bun fsync-bench.ts [recordBytes=2000000] [lineBytes=3000] [rounds=50]
import { open, rename, rm, mkdir, readFile, truncate, stat } from "node:fs/promises";
import { join } from "node:path";

const recordBytes = Number(process.argv[2] ?? 2_000_000);
const lineBytes = Number(process.argv[3] ?? 3000);
const rounds = Number(process.argv[4] ?? 50);
const dir = join(import.meta.dir, "bench");
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]?.toFixed(2);
const record = "x".repeat(recordBytes);
const line = `${JSON.stringify({ type: "message", pad: "y".repeat(lineBytes) })}\n`;

const whole: number[] = [];
for (let i = 0; i < rounds; i++) {
  const t0 = performance.now();
  const temp = join(dir, `.r.json.tmp-${i}`);
  const h = await open(temp, "w", 0o600);
  await h.writeFile(record);
  await h.sync();
  await h.close();
  await rename(temp, join(dir, "r.json"));
  whole.push(performance.now() - t0);
}
const appendSync: number[] = [];
const log = join(dir, "r.jsonl");
for (let i = 0; i < rounds; i++) {
  const t0 = performance.now();
  const h = await open(log, "a", 0o600);
  await h.write(line);
  await h.sync();
  await h.close();
  appendSync.push(performance.now() - t0);
}
const appendNoSync: number[] = [];
for (let i = 0; i < rounds; i++) {
  const t0 = performance.now();
  const h = await open(log, "a", 0o600);
  await h.write(line);
  await h.close();
  appendNoSync.push(performance.now() - t0);
}
console.log(`record=${recordBytes} B, line=${line.length} B, rounds=${rounds}`);
console.log(`today (temp+fsync+rename whole record): median ${med(whole)} ms`);
console.log(`append + fsync:                         median ${med(appendSync)} ms`);
console.log(`append, no fsync:                       median ${med(appendNoSync)} ms`);

const h = await open(log, "a");
await h.write(line.slice(0, Math.floor(line.length / 2)));
await h.close();
const text = await readFile(log, "utf8");
const cut = text.lastIndexOf("\n") + 1;
const tornBytes = text.length - cut;
await truncate(log, cut);
const after = await readFile(log, "utf8");
const lines = after.split("\n").filter((l) => l !== "");
const allParse = lines.every((l) => {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
});
console.log(
  `torn tail: ${tornBytes} B dropped by truncate-to-last-newline; ${lines.length} lines left, all parse=${allParse}, size=${(await stat(log)).size}`,
);
await rm(dir, { recursive: true, force: true });
```
```
record=2000000 B, line=3028 B, rounds=50
today (temp+fsync+rename whole record): median 2.05 ms
append + fsync:                         median 0.08 ms
append, no fsync:                       median 0.07 ms
torn tail: 1514 B dropped by truncate-to-last-newline; 100 lines left, all parse=true, size=302800
```

`convert-size.ts` (read-only; converts in memory, writes nothing):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? join(homedir(), ".config/tentacle/sessions");
let jsonBytes = 0, jsonlBytes = 0, n = 0, convertMs = 0, parseJsonlMs = 0;
let worst = { ratio: 0, id: "" };
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const name of readdirSync(join(root, d.name))) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const text = readFileSync(join(root, d.name, name), "utf8");
    const r = JSON.parse(text);
    const t0 = performance.now();
    const inc = `conv-${crypto.randomUUID()}`;
    const header = { format: "tentacle-session-log", schemaVersion: 1, id: r.id, cwd: r.cwd, model: r.model, createdAt: r.createdAt };
    const lines = [JSON.stringify(header)];
    let seq = 1;
    let prev: string | undefined;
    const push = (e: Record<string, unknown>) => {
      const id = `${inc}/${seq}`;
      lines.push(JSON.stringify({ ...e, seq, id, ...(prev ? { prev } : {}), ts: r.updatedAt }));
      prev = id;
      seq++;
    };
    push({ type: "base", critical: true, inc, reason: "create", count: r.messages.length });
    for (const m of r.messages) push({ type: "message", critical: true, message: m });
    if (typeof r.title === "object") push({ type: "title", title: { ...r.title } });
    const out = `${lines.join("\n")}\n`;
    convertMs += performance.now() - t0;
    const t1 = performance.now();
    for (const l of out.split("\n")) if (l) JSON.parse(l);
    parseJsonlMs += performance.now() - t1;
    jsonBytes += text.length;
    jsonlBytes += out.length;
    const ratio = out.length / text.length;
    if (ratio > worst.ratio) worst = { ratio, id: r.id };
    n++;
  }
}
console.log(`records=${n} json=${(jsonBytes / 1e6).toFixed(2)} MB (pretty, today) jsonl=${(jsonlBytes / 1e6).toFixed(2)} MB ratio=${(jsonlBytes / jsonBytes).toFixed(3)} worst=${worst.ratio.toFixed(3)}`);
console.log(`convert all in memory: ${convertMs.toFixed(1)} ms; JSON.parse every jsonl line: ${parseJsonlMs.toFixed(1)} ms`);
```
```
records=178 json=34.61 MB (pretty, today) jsonl=37.55 MB ratio=1.085 worst=1.675
convert all in memory: 43.5 ms; JSON.parse every jsonl line: 52.2 ms
```

`growth.ts` (read-only):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? join(homedir(), ".config/tentacle/sessions");
let projection = 0, replaced = 0, turns = 0, annotated = 0, messages = 0;
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const name of readdirSync(join(root, d.name))) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const r = JSON.parse(readFileSync(join(root, d.name, name), "utf8"));
    for (const m of r.messages) {
      const bytes = JSON.stringify(m).length;
      projection += bytes;
      messages++;
      if (m.role === "user") turns++;
      if (m.contextUsage) {
        annotated++;
        replaced += bytes + 120; // the replace envelope
      }
    }
  }
}
const markers = turns * 4 * 110;
console.log(`messages=${messages} annotated=${annotated} user-turns≈${turns}`);
console.log(`projection=${(projection / 1e6).toFixed(2)} MB; replace re-sends=${(replaced / 1e6).toFixed(2)} MB (+${((100 * replaced) / projection).toFixed(1)}%); markers≈${(markers / 1e6).toFixed(2)} MB`);
```
```
messages=26156 annotated=2001 user-turns≈688
projection=32.72 MB; replace re-sends=5.35 MB (+16.3%); markers≈0.30 MB
```

(+16.3 % is an upper bound: an annotation that lands BEFORE its message's commit rides in the
`message` entry and costs nothing extra.) With `keepSuperseded: true`, each compaction keeps
its old segment. The eval's model gives 5 × 200k-token compactions → a 5.36 MB log
(`docs/eval/session-persistence-format.md`, round 2). Nothing is pruned automatically.

### Owner answers (2026-11-07) — part 1

*— recorded by the orchestrator (claude-opus-5-5), 2026-11-07*

- **Legacy JSON: DROPPED.** "Ignora i vecchi json, non scrivere codice per convertirli o altro, eliminerò le cartelle e la build ora non promette retrocompatibilità." → NO legacy `<uid>.json` reader, NO lazy conversion, NO delete/aside of old files (Q6 removed). The new store reads only `<uid>.jsonl`; a legacy `.json` in the folder is IGNORED silently (not listed, not an error). Remove the "Legacy `<uid>.json` records are read as they are and converted at their next save." sentence from the §7 wording (Q14). Tests/fixtures that only existed for conversion are not written.
- **Q10 (`--in-process`) CHANGED:** the in-process path writes the SAME `<uid>.jsonl` format (whole current-segment rewrite at each save, atomic, with the lock; it ignores `keepSuperseded`), so NO JSON writer survives on the laptop. The owner decided to REMOVE `--in-process` / `--no-worker` and the worker-failure fallback in a SEPARATE later task (a worker that fails to start → a clear error); do not remove it here.
- **Plan APPROVED (owner, 2026-11-07)** with the changes above (no legacy JSON; `--in-process` writes the same `.jsonl`). All other recommendations accepted: Q1 one L task; Q2 unknown non-critical lines from a newer build skipped on load, kept on append, set aside before a rewrite would drop them; Q3 header line (no `type`/`critical`, own `schemaVersion`); Q4 `updatedAt` = file mtime; Q5 listing reads the logs (no index unless > 250 ms); Q7 `.aside` files in the log format; Q8 per-session lock file around every write, append only what is missing; Q9 plain `fsync` after every append; Q11 close a cut turn at LOAD; Q12 `keepSuperseded: true` only keeps (no viewer); Q13 check `seq` order + skip exact duplicates, no `prev` re-check on disk; Q14 the §7 wording as proposed minus the legacy-JSON sentence. Owner rule: never add or change a `critical` value.
