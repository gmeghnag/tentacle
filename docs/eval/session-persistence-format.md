# eval/session-persistence-format — JSONL on disk? Incremental read-back over RPC?

> **Status:** DECIDED by the owner 2026-11-07 (see "Owner decisions" at the end): typed event log on the wire AND on disk, 3 tasks
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** (A) M · (B-plain) L · (B-event-log) L, split into 3 tasks (M–L each) · (C) folded into the log (alone: S–M) · **Blast:** load-bearing (protocol `session/snapshot`, the persistence invariant, the daemon record) · **Suited:** strong model executes; mandatory fresh-context Review
>
> Round 1 (2026-11-07): (A) incremental read-back and (B) plain JSONL. Round 2
> (2026-11-07, owner input): (C) a `type` discriminator on persisted entries,
> and the pi-style typed EVENT LOG as the alternative for (B). The round 2
> verdict supersedes round 1's where they differ.

## Context

*— claude-opus-5-5, 2026-11-07*

### The question

Two questions, decided separately and then together:

- **(A) Incremental read-back.** Should the laptop stop reading the daemon's
  WHOLE history back (`session/snapshot`, every page) at every save, and read
  only what changed since its last read (a tail, or the full history on
  divergence)?
- **(B) JSONL on disk.** Should session records move from one JSON file per
  session, rewritten whole at every save (temp + fsync + rename), to an
  append-only JSONL file — on the laptop, on the `serve` daemon, or both?

Why now: `fix/run-session-never-saved` (observed merged on `main` during this
eval: `packages/cli/src/local-runtime.ts:445` saves at every `tool_result`)
turns a save per turn into a save per committed round, i.e. ~12× more saves.
Each save = full read-back over RPC + full-file rewrite, so a session's total
cost goes from O(n²/12) to O(n²). Pre-public: breaking changes are allowed with
a version bump (AGENTS §7), so the cheapest moment to change shape is now. The
owner asked for a serious answer: build only if the advantage is evident and
measured.

Line numbers are on `main` as of 2026-11-07 (the fix branch's lines for these
files are identical).

### Every reader and writer of a session record

**Laptop writers**

| Where | What |
|---|---|
| `packages/agent/src/session-store.ts:449` `JsonSessionStore.save` → `writeAtomic` :491-526 | per-uid serialized, coalesced queue; pretty JSON `JSON.stringify(record, null, 2)` :511; temp + `handle.sync()` (fsync) :141-149 + rename :512 |
| `session-store.ts:506-507` Q6 stale-writer guard | when `onAside` is set (the laptop store, `packages/cli/src/tui-sessions.ts:68`) EVERY save first re-reads and re-parses the file and compares message by message with `JSON.stringify` (`dropsHeld` :412-417) |
| `packages/cli/src/session-saver.ts:80` `SessionSaver.save` | fire-and-forget wrapper, notices, bounded `drain` |
| `packages/cli/src/local-runtime.ts:327-457` `persistingController` | at each `tool_result` (:445-447), turn end (:452-455), compaction (:467-470), title, idle (:423-428), history replace: `flush()` → `inner.readBack()` (:354) → mid-turn copies closed by `cutHistory` (:278-297, a synthetic closing tail the next save replaces) → `deps.saver.save` (:744). Serialized: one read in flight, at most one more queued |
| `packages/client/src/remote-client.ts:1093` `readBack` → `readSnapshotPages` :2112-2145 | pages of `SNAPSHOT_PAGE = 200` messages (:119), newest first, one RPC round trip each, restart on `StaleCursor` (:2099-2110). The result is cast, not zod-validated |
| `packages/cli/src/kept-index.ts:153` | `saver.observe` — keeps only the session **id** in the kept index, never content |

**Daemon side**

| Where | What |
|---|---|
| `packages/daemon/src/hosted-session.ts:1074-1092` `snapshotPage` | slices `session.messages` at the cut; cursor `"<epoch>/<start>"` |
| `hosted-session.ts:1930-1950` `historyReplaced` | compaction / `context_reset` → a new random `epoch` |
| `hosted-session.ts:767` `persist` → `packages/daemon/src/session-persister.ts:88` `schedule` | `serve` only (`packages/cli/src/serve.ts:122`, the same `JsonSessionStore`, no Q6 guard). 15 call sites, among them EVERY `history_commit` (:1512-1522): `agent.ts:950` after an assistant message with calls, `:1360` after each tool result → ≥ 2 whole-record rewrites per round |
| `packages/daemon/src/persisted-session.ts:101-142` | the daemon record = messages + MUTABLE state rewritten at every write: `turn` (steering, pending asks, `inFlight`), `turns` keys, `enqueueIds`, `returned`, `title`, `head`, `archivedAt`, `lastActiveAt`; `DAEMON_RECORD_VERSION = 8` (:53) |

**Readers**

| Where | What |
|---|---|
| `packages/cli/src/session-resume.ts:63` / `:89` | `--resume <uid>` loads one file; `--resume` picker `store.list()` parses EVERY file whole (`session-store.ts:648-682`) and keeps every record in memory |
| `packages/cli/src/session-projects.ts:33` | resume of an id from another project |
| `packages/cli/src/tui-sessions.ts:137-146` `readSessionRecord` | an attach to a detached run seeds from the laptop copy |
| `packages/cli/src/serve.ts:230-254` | `serve` start: `store.scan()` one record at a time; archived → metadata only |
| `session-persister.ts:173` | an archived session's reopen |
| `/sessions` and `connect --resume` (`packages/cli/src/connect.ts:225`) | `session/list` over RPC: daemon memory, **no file read** |
| Mobile (`apps/mobile/src`: `rn-websocket.ts`, `spike.ts`) | spike only, **no transcript cache today**. Planned: history via `snapshot` + the replayable stream with `HistoryCut {epoch, seq}`, "offline read from the last cache" (`docs/eval/mobile-app.md:145,181`). The phone's cache is its own store; it never reads laptop or daemon files |

No export/import command exists. Test fixtures build records in memory.

### Is the history append-only? (decides how either change can work)

Within one epoch, **no — almost**:

- `agent.ts:1156` replaces a user/tool message already behind a cut to add
  `contextUsage` (documented in `docs/feat/context-awareness.md:685-693`).
- `agent/src/session.ts:87-95` `replaceAgent` replaces `messages[0]` (the
  system prompt) in place between turns (`/settings`), same epoch.
- `agent.ts:1009` `pop()` of an empty round — never behind a cut
  (`docs/feat/session-history-cut.md:119-123`).
- The laptop's own `cutHistory` tail exists only in mid-turn copies and is
  replaced by the next save.
- Compaction and `context_reset` replace the whole history (new epoch).

Every in-epoch change REPLACES an array element: `ChatMessage` fields are all
`readonly` (`packages/core/src/model.ts:28-50`), so a message object is never
edited in place without a cast. Reference identity is therefore an exact,
O(n)-pointer change detector daemon-side.

### Measurements

Machine: M-series Mac, bun 1.4.x, APFS. Scratch: `.tentacle/tmp/session-persistence-format/`.
Synthetic sessions are built from REAL message shapes sampled from
`~/.config/tentacle/sessions` (read-only). Tokens ≈ compact JSON bytes / 4.

**M0 — real shapes** (`shapes.ts`)

```
files=173 total=33.8MB
file bytes p50=75806 p90=558372 p99=967719 max=1444196
messages=25436 pretty/compact=1.055
system    n=173 p50=2426 p90=14013 p99=33518 max=33531 mean=6628
user      n=668 p50=103 p90=343 p99=5266 max=9149 mean=293
assistant n=11915 p50=412 p90=2195 p99=7661 max=45333 mean=945
tool      n=12680 p50=514 p90=4066 p99=11805 max=31646 mean=1515
toolCalls/assistant mean=1.06
largest: 1444196 bytes, 1161 messages
```

A round (assistant + its results) is ~2.6 KB. Compaction bounds a record to
about one context window: the largest real file is 1.4 MB (~350k tokens);
1M tokens needs a 1M-window model.

**M1 — a whole session, one save per committed round** (`bench-save.ts`).
TODAY = page frames of 200 messages parsed on the laptop + the REAL
`JsonSessionStore` with the Q6 guard (fsync + rename). JSONL = one tail frame
from the first changed index + truncate-to-that-line + append + fsync. Every
round annotates the previous round's last message (`contextUsage`), so JSONL
pays the in-place-rewrite path at every save; mid-turn saves carry the closing
tail.

```
tokens≈100000 msgs=355 saves=167 final compact=0.42MB
TODAY syncCPU/save p50=0.59ms p99=1.33ms last10%p50=1.21ms | wireParse last10%p50=0.44 guard=0.46 stringify=0.33 | saveWall p50=0.84 p99=1.71ms | disk total=36.4MB wire total=33.9MB wire/save last10%p50=382.1KB pages=2
JSONL syncCPU/save p50=0.01ms p99=0.04ms last10%p50=0.01ms | wireParse last10%p50=0.01 guard=0.00 stringify=0.00 | saveWall p50=0.12 p99=0.49ms | disk total=0.6MB wire total=0.6MB wire/save last10%p50=2.7KB pages=1
tokens≈500000 msgs=1606 saves=745 final compact=2.05MB
TODAY syncCPU/save p50=3.50ms p99=7.40ms last10%p50=6.98ms | wireParse last10%p50=2.53 guard=2.64 stringify=1.79 | saveWall p50=3.42 p99=6.92ms | disk total=806.3MB wire total=757.1MB wire/save last10%p50=1957.9KB pages=8
JSONL syncCPU/save p50=0.01ms p99=0.05ms last10%p50=0.02ms | wireParse last10%p50=0.01 guard=0.00 stringify=0.01 | saveWall p50=0.15 p99=2.74ms | disk total=3.2MB wire total=3.2MB wire/save last10%p50=2.6KB pages=1
tokens≈1000000 msgs=3377 saves=1574 final compact=4.09MB
TODAY syncCPU/save p50=7.71ms p99=15.51ms last10%p50=14.90ms | wireParse last10%p50=5.19 guard=5.45 stringify=4.18 | saveWall p50=6.88 p99=13.70ms | disk total=3525.8MB wire total=3306.9MB wire/save last10%p50=3896.1KB pages=17
JSONL syncCPU/save p50=0.02ms p99=0.05ms last10%p50=0.02ms | wireParse last10%p50=0.02 guard=0.00 stringify=0.01 | saveWall p50=0.15 p99=0.55ms | disk total=6.4MB wire total=6.4MB wire/save last10%p50=2.7KB pages=1
```

Reading it per question:

- **Wire (A):** at 500k tokens a save moves 1.96 MB in 8 sequential round
  trips; a tail moves 2.6 KB in one. Whole session: 757 MB vs 3.2 MB
  (1M: 3.3 GB vs 6.4 MB).
- **Laptop main thread (A+B):** `syncCpu` is NOT one block: page parses run
  between round trips, the guard's parse runs in `load`, then
  `dropsHeld` + stringify run in one stretch. The largest contiguous block at
  1M tokens is ≈ guard + stringify ≲ 10 ms; at a real-sized record (≤ 1.4 MB)
  ≲ 3 ms. **Under one 60 Hz frame (16.7 ms) at every measured size: today's
  saves do not cause frame hitches.**
- **Disk (B):** total bytes written are O(n²) today: 806 MB (500k) and 3.5 GB
  (1M) for ONE session vs 3.2 / 6.4 MB. But the wall time of a save, fsync
  included, is 3.4 ms p50 at 500k and ~7 ms at 1M — fast, async, off the
  critical path. The `serve` daemon does ≥ 2 whole rewrites per round
  (`history_commit` after the assistant message and after each result), so its
  total is ≈ 2× the laptop's — derived from the call sites, not measured.

**M2 — wire time on the k8s exec path (estimate from measured link figures).**
`docs/eval/rpc-flow-control.md` measured the real stack (`KubeClient.openExec`,
`v4.channel.k8s.io`, OCP cluster, 2026-10-17): small RTT p50 47.5 ms,
12–21.5 Mbit/s for 1–5 MB frames, and **a ping queued behind a 1 MB frame
waited 1.34 s** (one ordered stream, head-of-line). Read-back time ≈
bytes × 8 / (12–21.5 Mbit/s) + pages × 47.5 ms:

| Session | Bytes / save | Pages | Link busy per round (est.) | Tail |
|---|---|---|---|---|
| 100k tokens | 382 KB | 2 | 0.24–0.35 s | 2.7 KB, 1 RTT ≈ 0.05 s |
| 500k tokens | 1.96 MB | 8 | 1.1–1.7 s | 2.6 KB ≈ 0.05 s |
| 1M tokens | 3.9 MB | 17 | 2.3–3.4 s | 2.7 KB ≈ 0.05 s |

A round is typically seconds (a model response + one tool), so at 500k+
tokens the read-back occupies the pod link for a large part of every round,
ahead of the next round's streamed chunks, permission prompts and keepalives
(each 200-message page, ~230 KB, delays whatever follows by ~0.1–0.15 s). The
saver coalesces (one read in flight, one queued), so it degrades to "the link
is always reading back" rather than an unbounded queue. Frame size is NOT a
risk: pages keep a frame far below the 8 MiB `maxFrameBytes`
(`docs/eval/oversize-frame-hang.md:27`). Not measured end to end on a cluster
(no cluster in this run): to measure, run the TUI against a pod with a
pre-seeded 2 MB session and time `readBack` + the delay of a streamed chunk
issued during it.

**M3 — fsync** (`fsync.mjs`, macOS host)

```
rewrite 0.4MB: p50=0.20ms p99=0.35ms
rewrite 2MB: p50=0.47ms p99=0.64ms
rewrite 4MB: p50=0.82ms p99=0.88ms
append 2.7KB: p50=0.03ms p99=0.05ms
```

macOS `fsync` does not force the drive cache (no `F_FULLFSYNC`), so this is a
lower bound. **Linux not measured** (running the same script in a `node:22`
container needed an approval this run did not have): `docker run --rm -v
$PWD/fsync.mjs:/b/fsync.mjs:ro node:22 node /b/fsync.mjs /var/tmp/x`. On a
Linux `serve` host a 4 MB fsync is plausibly 5–30 ms — still async I/O, it
blocks no thread.

**M4 — `--resume` listing** (`bench-list.ts`: 200 sessions, sizes drawn from
the real distribution, 38 MB)

```
200 sessions, 38.0MB on disk
run 0: list() 77ms (200 records) · header-only read 4.5ms
run 1: list() 76ms (200 records) · header-only read 3.9ms
run 2: list() 71ms (200 records) · header-only read 3.6ms
```

~75 ms once, before Ink mounts. A metadata header would make it ~4 ms; that
saving is real but not user-visible. `/sessions` does not read files.

**M5 — crash and corruption** (`crash.ts`)

```
SIGKILL mid-append: 149.5MB, complete lines ok=115711 bad=0, last line torn=false (0 chars)
1 corrupted byte: whole JSON parses=false · JSONL lines ok=1551 bad=1 of 1552
```

- Today: temp + fsync + rename → a crash leaves the old file or the new one,
  never a torn one (`session-store.ts:8-12`); leftovers are swept (:533-554).
  A single corrupted byte makes the whole record `unreadable` (reported, never
  half-loaded — the strict-parser rule).
- JSONL: a killed process cannot tear a line written by one `write()`; a power
  loss or an OS crash can tear the last line, so the loader must drop an
  unterminated last line. One corrupted byte loses one line — but for a
  message history "load everything except line 812" is a broken history (a
  tool result without its call), so the strict parser would refuse it anyway.
  The corruption advantage is mostly theoretical here.

### Qualitative

**What (B) has to express that an append log does not do natively**

1. **In-epoch replacements** (contextUsage behind the cut, system head swap):
   truncate back to the changed line and rewrite — needs a line-offset index
   kept by the writer, or a "replace i" record that every reader applies.
2. **Epochs** (compaction, `context_reset`, `/clear` → new session): an epoch
   marker + rewrite, or a new file per epoch. A rewrite is today's whole-file
   path anyway.
3. **The mid-turn closing tail**: truncate + append every round, or move
   `cutHistory` to load time (a semantic change to what a record means:
   today a record is always a valid, closed history).
4. **Mutable metadata**: `title`, `updatedAt`, and on the daemon the whole
   `turn` / `turns` / `enqueueIds` / `returned` / `archivedAt` / `head` state
   changes at nearly every write. JSONL needs a state line appended per write
   (replay to the last) or a sidecar file rewritten whole — the daemon's
   per-write rewrite does not go away, it moves.
5. **Multiple writers**: several TUIs of one detached run each save the same
   uid (`docs/fix/run-session-never-saved.md` Review L3); today cross-process
   races resolve as "last rename wins + Q6 sets a shorter copy aside". Two
   processes truncating and appending one JSONL file interleave and corrupt it
   unless a cross-process lock is added.
6. **Strict parsing and versions**: two record kinds (laptop `SessionRecord`,
   daemon record `v8`) would need new parsers, a new `schemaVersion`, and the
   Q6 guard rewritten (prefix detection on lines).

**What (A) has to express**

The daemon already has the pieces: `epoch` per history, a cut, and a cursor
`"<epoch>/<start>"` (`hosted-session.ts:1074-1119`). What is missing is "which
indexes changed since the client's last read": the in-epoch replacements above
mean "send everything after my length" would silently miss them (a stale
`contextUsage` is display-only, but a stale system head is model-visible on a
later resume). Reference identity makes it exact and cheap (see Options).

**Trust (AGENTS §7 "a pod is not trusted")**: (A) does not change what the pod
can do — the laptop's copy is already entirely pod-supplied content. The
laptop must still validate the tail (same message checks) and fall back to a
full read on any inconsistency (unknown epoch, `from` beyond its length).

**Mobile**: the phone's need is "show the cached transcript, then catch up
cheaply after an app kill / on cellular". That is exactly (A)'s primitive
(`base {epoch, rev}` → tail or full), reusable as is. The laptop's on-disk
format (B) is irrelevant to the phone: its cache is its own store on the
device.

**Other agents (data point only)**: Claude Code writes transcripts as
append-only JSONL, but it is the single writer of its own history and records
compaction as appended entries. Tentacle's laptop file is a COPY of a history
the daemon owns and mutates; the conditions that make JSONL natural there do
not hold here.

### Options

| | Cost now | Cost in a month | Wins (measured) | Risks | Consumers touched |
|---|---|---|---|---|---|
| **0. Keep as is** | 0 | 0 | — | Pod link busy 1.1–1.7 s per round at 500k tokens; O(n²) bytes (807 MB/session at 500k) | none |
| **A. Incremental read-back** | M | M + every new reader (mobile 12) built on full reads | Wire/save 1.96 MB → 2.6 KB (500k), 8 RTT → 1; laptop wire-parse ~2.5 ms → 0.01 ms; mobile catch-up primitive | Missed in-epoch replacement (designed out: rev per index + full fallback); one more protocol field | protocol `SnapshotParams/Result`, daemon `HostedSession`, client `readBack`, cli `persistingController` |
| **B. JSONL on disk (laptop + daemon)** | L | L + a file-format migration once public | Disk 807 MB → 3 MB per 500k session; laptop guard+stringify ~4.4 ms → ~0; listing 75 → 4 ms | Multi-writer corruption, metadata state lines, truncate paths, new strict parsers for 2 kinds, Q6 rewritten, cutHistory semantics | store, saver, persister, `persisted-session`, serve scan, resume/list, tests' fixtures |
| **B without A** | L | | Disk only; the wire stays O(n) per save — the dominant cost remains | as B | as B |
| **A without B** | M | | All wire wins; the laptop still rewrites ≤ 4 MB per save (≲ 7 ms async, ≲ 10 ms CPU split across stretches) | as A | as A |

(Round 2 extends this table below: "Options, round 2".)

### Round 2 — (C) typed entries and the event-log model

*— claude-opus-5-5, 2026-11-07 (round 2)*

#### (C) The question

Should every persisted entry carry a `type` (`message`, `model_change`,
`compaction`, `settings_change`, `usage`, …), whatever the container (JSON or
a log)? Owner: "today we only have messages and tool calls, tomorrow we may
want to store something else."

#### What is lost or kept only as mutable state today (verified)

| Fact | Today | Evidence |
|---|---|---|
| **The transcript before a compaction / `context_reset`** | **Lost on disk.** The laptop saves the read-back after `compact` (`local-runtime.ts:467-470`) and the file is replaced by the compacted history; Q6 does not set it aside ("a rewritten history is not one", `session-store.ts:408-417`). The daemon record is rewritten the same way | `hosted-session.ts:1930-1950` (new epoch, history replaced) |
| Session settings (model/profile carried, overridden keys) | `settingsReport` lives in `HostedSession` memory, NOT in `DaemonSessionState` (`persisted-session.ts:101-119`) → lost at a `serve` restart; the laptop record's `model` is one static string per writer (`session-store.ts:94-113`, `session-persister.ts:220-227`) | `hosted-session.ts:1456-1472` |
| System-prompt change after `/settings` | replaced in place at index 0, no trace (`session.ts:87-95`) | — |
| Token usage / cost per model call | `agent_usage` and `subagent_usage` are display-only updates (`protocol/src/updates.ts:77-82, 123-145`); only `contextUsage` (a window estimate) rides a message | — |
| Sub-agent runs | only the final result in the parent's tool message; start/tools/usage/end are display-only `tool_progress` | `updates.ts:123-145` |
| Permission decisions | only `denialReply` on a refused call's tool message; session grants live in memory | `model.ts:47-50`, `hosted-session.ts:1444` |
| Title | top-level field, latest wins (`session-store.ts:35`) | — |
| Turn boundaries, stop reasons | not in the laptop record; the daemon record keeps `turns` keys + `turn` state, rewritten every write | `persisted-session.ts:94-119` |

So there IS something to store, and the most valuable item (the pre-compaction
transcript) cannot be kept by ANY rewrite-whole format without keeping a
second copy.

#### (C) Unknown types vs AGENTS §7

Today's rule — strict parser, refuse an unknown field, `schemaVersion` on the
daemon record — exists because the format is **rewritten**: an older build
that half-loaded a record would drop what it did not know at its next write
(`session-store.ts:28-33, 213-218`; `persisted-session.ts:31-52`). Hence:

- **In a rewritten JSON container**, typed entries do not change that: an
  unknown type must still be refused (or carried back verbatim by the older
  writer, which is fragile once edits move indexes). (C) alone buys a cleaner
  extension point and a place for the facts above, nothing more.
- **In an append-only log**, an older reader never rewrites, so it can
  **skip** an unknown entry without losing it on disk. The safe rule is a
  per-entry `critical` flag (PNG-chunk style), mirroring `UPDATE_CLASS`
  display/mandatory (`protocol/updates.ts`): unknown + `critical` → refuse the
  file loudly (today's behaviour); unknown + not critical → skip, keep. Known
  types stay strictly parsed; the header `version` bumps only for a changed
  meaning of an existing type. This turns objection 6 of round 1 (strict
  parsers) from a cost into an advantage.

**Proposed new wording of the §7 sentence** "Persist only `ChatMessage`s —
never rendering-only events (e.g. `steer`)":

> Persist only **durable facts**: the conversation (`ChatMessage`s) and typed
> facts a later reader needs to reproduce or explain it (history edits,
> compaction / reset boundaries, settings and model changes, usage, title,
> turn boundaries). Never rendering-only events — anything that only matters
> live or is fully implied by the durable facts (chunks, `steer`,
> `tool_call_phase`, `queued`). A persisted entry is never authoritative for
> permissions: an entry written from a pod's stream can inform a viewer, never
> grant anything on load.

#### The pi model (owner's sample, `pi-shape.ts`)

```
0 session id=01a10c28-5861-7692-837d-f413cb6f04b1 parent=undefined bytes=137 {"version":3,"cwd":"/Users/gmeghnag"}
1 model_change id=e10bab1e parent=null bytes=157 {"provider":"llamacpp","modelId":"unsloth/Qwen3.8-27B-UD-IQ3_S"}
2 thinking_level_change id=1dcff9c7 parent=e10bab1e bytes=134 {"thinkingLevel":"medium"}
3 model_change id=47ca06a2 parent=1dcff9c7 bytes=158 {"provider":"Models Corp Qwen","modelId":"Qwen3.8-27B-FP8"}
4 message id=48d94eb4 parent=47ca06a2 bytes=7653 message{role,content,sections,timestamp,toolsAdded} role=system {}
5 message id=56f433f3 parent=48d94eb4 bytes=189 message{role,content,timestamp} role=user {}
6 message id=fb2144b5 parent=56f433f3 bytes=474 message{role,content,api,provider,model,usage,stopReason,timestamp,errorMessage,thinkingLevel} role=assistant {}
7 context_edit id=71757cfa parent=fb2144b5 bytes=141 {"targetId":"fb2144b5","replacement":null}
8 message id=c1695328 parent=71757cfa bytes=474 message{role,content,api,provider,model,usage,stopReason,timestamp,errorMessage,thinkingLevel} role=assistant {}
9 context_edit id=06614144 parent=c1695328 bytes=141 {"targetId":"c1695328","replacement":null}
10 message id=79cebf2e parent=06614144 bytes=474 message{role,content,api,provider,model,usage,stopReason,timestamp,errorMessage,thinkingLevel} role=assistant {}
11 context_edit id=1c1a2564 parent=79cebf2e bytes=141 {"targetId":"79cebf2e","replacement":null}
12 message id=d286c53b parent=1c1a2564 bytes=474 message{role,content,api,provider,model,usage,stopReason,timestamp,errorMessage,thinkingLevel} role=assistant {}
branch points: 1
```

(The one "branch point" is an artefact: the header and line 1 both have no
parent. The sample is a linear chain.) What it shows: a `session` header with
`version` + `cwd`; settings changes as entries; `usage` + `stopReason` on each
assistant entry; and a failed round REMOVED by appending
`context_edit {targetId, replacement: null}` — history edits as events, the
log never rewritten. Each entry's `parentId` is the previous entry, so a branch
(fork at an earlier entry) costs nothing extra in the format.

#### Round 1's objections to (B), re-examined under the event-log model

| # | Objection (round 1) | Under an event log | Status |
|---|---|---|---|
| 1 | Not append-only within an epoch (contextUsage, system head swap) | `message_replace {target, patch}` entries. Replay with one edit per round: **+2.2 ms at 1M tokens** (7.4 vs 5.2 ms, M6). The daemon derives them by reference diff: **5 µs per commit at 3 353 messages** (M8) | resolved, measured |
| 2 | Epochs (compaction, reset) | a `compaction` entry; the projection restarts at its summary. The log KEEPS the earlier transcript (today lost). 5 compactions × 200k tokens: 5.36 MB log, replay-all 9.0 ms, replay from the last compaction 2.9 ms (M6) | resolved + a feature |
| 3 | The mid-turn closing tail | never written. A log ending inside a turn (`turn_start` without `turn_end`) is closed by the READER (today's `cutHistory`, moved to load). The "interrupted vs not run" label needs a durable `call_started` entry — the daemon already persists the same fact as `turn.inFlight` (`persisted-session.ts:86-91`) | resolved, semantic change (a file is no longer "always closed"; the projection is) |
| 4 | Mutable state rewritten at every write | laptop: title / settings / meta as latest-wins entries; listing reads a `meta` checkpoint from the last 16 KB: **200 files in 4.5 ms** (M6). Daemon: the suspended-turn state (`turn`, `turns`, `enqueueIds`, `returned`) is a small state, best kept as a whole-file sidecar of a few KB rewritten per write, NOT as events (it drives `docs/feat/suspended-turn-resume.md`; re-expressing it is the riskiest part and buys nothing — it is small) | resolved for the laptop; daemon: sidecar |
| 5 | Several writers of one uid | each TUI appends whole lines with `O_APPEND`, one `write()` per line, entries carry the daemon's `seq`; replay applies `seq == applied + 1`, skips `≤ applied`. **4 writers × 3 000 lines (3 KB and 70 KB), 0 torn lines, duplicates removed by seq** (M7). The Q6 guard and its `.aside` files become unnecessary: a stale writer only re-appends seqs already there | resolved on a local FS (not NFS: say so in the doc of the task) |
| 6 | New strict parsers, version rules | strict per known type + `critical` flag + header `version` (see (C)); skip-and-keep is safe because nothing is rewritten | becomes an advantage |

Each objection falls. What remains is cost (below) and three design facts to
get right: seq continuity when a POD daemon restarts (it keeps nothing: the
laptop's log is the truth and must reseed the new daemon with its last seq),
projection drift (a `meta` checkpoint carries `messages` count + a hash of the
last message; mismatch → full resync), and trust (each entry validated
strictly on the laptop, size-capped, never authoritative for permissions).

#### Does the log subsume (A)? One log for wire and disk?

Yes. (A)'s `base {epoch, rev}` is a weaker form of "entries after seq N": the
same daemon-side reference diff produces both. With ONE typed log:

- **wire:** `session/log {after: N}` → the entries after N (a tail at steady
  state: the 2.6 KB of M1), or everything from 0 for a cold reader. It
  replaces the paged `snapshot` for history (paging by seq).
- **laptop disk:** append the received lines verbatim — the wire format IS
  the file format; nothing is re-serialized (stringify cost of M1 → 0).
- **mobile:** the cache is the same log; catch-up after an app kill or on
  cellular = `log {after: lastSeq}`, then attach to the live stream from the
  cut. Offline read = local replay. This is the sync primitive mobile task 12
  needs, and it is the SAME code path as the TUI's (AGENTS §7 one session
  path).
- **not in the log:** the live update stream (chunks, phases, queue) stays
  separate and ephemeral; the log holds durable facts only. `HistoryCut`
  gains the log seq so a client knows where the stream resumes.

#### Measurements, round 2

**M6 — event-log replay and listing** (`bench-eventlog.ts`: typed entries
with `seq`; one `message_replace` per round; `usage` + `meta` per turn)

```
tokens/epoch≈500000 compactions=0 entries=2678 edits=783 log=2.23MB vs today's record=2.12MB | load: replay-all p50=3.6ms · replay-from-last-compaction p50=3.7ms · today JSON.parse p50=2.6ms | listing 200 × tail-16KB=4.4ms
tokens/epoch≈1000000 compactions=0 entries=5092 edits=1491 log=4.44MB vs today's record=4.23MB | load: replay-all p50=7.4ms · replay-from-last-compaction p50=7.5ms · today JSON.parse p50=5.2ms | listing 200 × tail-16KB=4.5ms
tokens/epoch≈200000 compactions=5 entries=6299 edits=1833 log=5.36MB vs today's record=0.84MB | load: replay-all p50=9.0ms · replay-from-last-compaction p50=2.9ms · today JSON.parse p50=1.0ms | listing 200 × tail-16KB=4.5ms
```

Envelope overhead +5 %. Load is a one-off before Ink mounts. The "from last
compaction" figure still reads and splits the whole file; a real seek (offset
in the `meta` checkpoint) would be lower.

**M7 — several writers** (`append-race.ts`, APFS)

```
writers=4 lines=12000 (expected 12000) line=3000B torn/interleaved=0 distinct seqs after dedupe=3000
writers=4 lines=12000 (expected 12000) line=70000B torn/interleaved=0 distinct seqs after dedupe=3000
```

`O_APPEND` positioning is atomic per `write()` (POSIX); whole-line
non-interleaving for regular files holds on APFS (measured) and on Linux
local filesystems (inode lock), not on NFS. Linux not measured here.

**M8 — daemon-side derivation** (`bench-diff.ts`)

```
messages=3353 replaced=3348 appended=3 per-commit diff p50=5.0µs p99=8.8µs
```

(`replaced=3348` prints the index found: one element replaced, at 3348; 3
appended.) Pointer comparison only: free at any realistic size.

Not measured: a replay of a log written by real tentacle (none exists yet);
seq continuity across a pod restart (a design question, not a cost).

### Options, round 2

| | Cost now | Cost in a month | Wins | Risks |
|---|---|---|---|---|
| **A-plain** (`base {epoch, rev}`) | M | M, and mobile task 12 builds its cache on it; a later log replaces it → two migrations | wire 1.96 MB → 2.6 KB/save (500k) | thrown away if the log comes |
| **A-as-log** (typed entries + seq on the wire; laptop still writes its JSON projection) | M–L (+ entry schema (C), seq, compaction entry) | L: mobile and any new reader already on full reads | all of A + mobile's sync primitive + the format of the disk log, fixed once | projection drift (checkpoint hash), pod reseed |
| **B-plain JSONL** | L | L | disk O(n) | all of round 1's objections stand (no events) |
| **B-event-log, laptop** (append what the wire sent) | M after A-as-log | M–L + a format migration of users' files (pre-public today: none) | Q6 guard + asides removed; pre-compaction transcript kept; forward-compatible unknown entries; disk 807 MB → ~3 MB/session (500k) | load semantics change (reader closes open turns) |
| **B-event-log, `serve` daemon** (log + state sidecar) | M–L | same | daemon disk O(n) (today ≈ 2× the laptop's 807 MB at 500k); same format everywhere | suspended-turn reload re-plumbed |
| **C alone, in today's JSON** | S–M (record bump on both kinds) | same | a place for settings/usage/compaction facts | unknown types must still be refused; the pre-compaction transcript still lost |

## Implementation

*— claude-opus-5-5, 2026-11-07*

Empty until promoted (AGENTS §10).

**Round 2 sketch (supersedes the round 1 sketch below where they differ)** —
*claude-opus-5-5, 2026-11-07 (round 2)*, to be source-verified again on
promotion:

- **Entry schema (protocol, = (C)):** `{seq, ts, type, critical?, …}`. v1
  types: `session` (header: version, id, cwd, createdAt) · `message` ·
  `message_replace {target: seq, message}` · `compaction {reason:
  compact|context_reset}` followed by the new head's `message` entries ·
  `turn_start {turnId}` / `turn_end {turnId, stopReason}` · `call_started
  {callId}` · `title` · `settings {report}` · `usage {promptTokens,
  completionTokens}` · `meta {updatedAt, messages, lastHash}` (checkpoint).
  Critical: header, message, message_replace, compaction, turn_*,
  call_started. The rest skippable. Sub-agent and permission-decision entries
  are candidates, not v1.
- **Daemon:** `HostedSession` derives entries at each `recordCut` /
  `historyReplaced` / title / settings change by reference diff against the
  previous commit (M8), keeps the session's entries in memory, numbers them
  with a per-session `seq` that survives compaction (the epoch becomes an
  entry, not a reset). `session/log {after}` serves them, paged by seq.
  `open` gains a reseed (`entries` or `messages` + `baseSeq`) so a new POD
  daemon continues the laptop's numbering.
- **Client/cli (task 1):** `readBack` → `log {after: lastSeq}`; replay into
  the projection; the laptop still writes today's JSON record from it (no
  disk change yet). Verify the `meta` checkpoint; mismatch → `log {after: 0}`.
- **Laptop store (task 2):** `<uid>.jsonl`, append the received lines
  verbatim (`O_APPEND`, one `write()` per line, fsync per save); loader =
  strict per known type, `critical` rule, seq dedupe, closes an open turn
  (moved `cutHistory`); listing from the tail `meta`; Q6 guard and asides
  removed; `--resume`, `findInOtherProjects`, `readSessionRecord`, `serve`'s
  seed path adapted.
- **`serve` store (task 3):** the same log + a `<uid>.state.json` sidecar for
  the suspended-turn state; reload = replay + sidecar; archive index from the
  tail `meta`.

Round 1 sketch (plain (A)), kept for comparison:

- **Daemon:** per epoch, a `rev` counter bumped at each `recordCut`, and
  `changedAt: number[]` (the rev at which index i last changed), refreshed at
  each cut by comparing `session.messages[i]` with a kept reference array —
  O(n) pointer compares, no stringify. `snapshot{base: {epoch, rev}}` → if the
  epoch matches and the rev is known: `{from, messages: [from, cut.length)}`
  with `from` = the lowest index changed after `rev` (else the client's old
  length); otherwise the paged full read as today.
- **Client/cli:** `readBack` passes `base` from the last read; keeps the
  messages it holds; applies the tail at `from`; validates; falls back to the
  full paged read on any mismatch. The laptop file stays JSON, written from the
  in-memory copy.
- **Protocol:** an optional `base` on `SnapshotParams` and optional
  `from` / `rev` on `SnapshotResult`. Strip schemas: an older daemon ignores
  `base` and answers a normal first page (no `from`) → the client falls back.
  No `PROTOCOL_VERSION` bump needed (AGENTS §7 forward compatibility).
- **Failure modes to cover:** a compaction between reads (new epoch → full),
  a head swap (`changedAt[0]` → from 0), contextUsage annotation (from = that
  index), a reconnect to a restarted daemon (unknown epoch → full), two TUIs
  on one session (each holds its own base — no shared state), a hostile pod
  sending `from` > held length (refuse → full).
- **Tests:** a daemon unit test per replacement kind (red: a naive
  "since length" implementation misses the head swap and the annotation —
  mutation check), client fallback on each divergence, a byte-count test that a
  steady-state save moves one tail.

## Execution

*— claude-opus-5-5, 2026-11-07*

None (eval). Scripts and outputs above, pasted below in full.

### Scripts (all in `.tentacle/tmp/session-persistence-format/`)

`shapes.ts`

```ts
// Profile real laptop session files (READ-ONLY on ~/.config/tentacle/sessions).
// Output: size distribution, message-size distribution per role, pretty vs compact ratio.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = `${process.env.HOME}/.config/tentacle/sessions`;
const files: { path: string; bytes: number }[] = [];
for (const dir of readdirSync(root)) {
  const d = join(root, dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d)) {
    if (f.endsWith(".json")) files.push({ path: join(d, f), bytes: statSync(join(d, f)).size });
  }
}
files.sort((a, b) => a.bytes - b.bytes);
const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
const sizes = files.map((f) => f.bytes);
console.log(`files=${files.length} total=${(sizes.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}MB`);
console.log(`file bytes p50=${q(sizes, 0.5)} p90=${q(sizes, 0.9)} p99=${q(sizes, 0.99)} max=${sizes.at(-1)}`);
const per: Record<string, number[]> = {};
let msgs = 0, prettyBytes = 0, compactBytes = 0, toolCallsPerAssistant: number[] = [];
let largest = files.at(-1);
for (const f of files) {
  const text = readFileSync(f.path, "utf8");
  const rec = JSON.parse(text);
  prettyBytes += text.length;
  compactBytes += JSON.stringify(rec).length;
  for (const m of rec.messages ?? []) {
    msgs++;
    (per[m.role] ??= []).push(JSON.stringify(m).length);
    if (m.role === "assistant") toolCallsPerAssistant.push(m.toolCalls?.length ?? 0);
  }
}
console.log(`messages=${msgs} pretty/compact=${(prettyBytes / compactBytes).toFixed(3)}`);
for (const [role, arr] of Object.entries(per)) {
  arr.sort((a, b) => a - b);
  console.log(`${role.padEnd(9)} n=${arr.length} p50=${q(arr, 0.5)} p90=${q(arr, 0.9)} p99=${q(arr, 0.99)} max=${arr.at(-1)} mean=${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)}`);
}
const tc = toolCallsPerAssistant.reduce((a, b) => a + b, 0) / toolCallsPerAssistant.length;
console.log(`toolCalls/assistant mean=${tc.toFixed(2)}`);
const big = JSON.parse(readFileSync(largest!.path, "utf8"));
console.log(`largest: ${largest!.bytes} bytes, ${big.messages.length} messages`);
```

`gen.ts`

```ts
// Synthetic sessions built from REAL message shapes (read-only on ~/.config/tentacle/sessions).
// A session = real system message + turns; a turn = a real user prompt + N real "rounds"
// (one assistant message + the tool messages that answer its calls), sampled with a seeded PRNG.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Msg = Record<string, unknown> & { role: string; content: string };
export interface Step {
  /** messages.length after this step */
  end: number;
  /** true: the turn's last round (turn-end save); false: a mid-turn round commit */
  turnEnd: boolean;
}

const root = `${process.env.HOME}/.config/tentacle/sessions`;
const rounds: Msg[][] = [];
const prompts: Msg[] = [];
const systems: Msg[] = [];
for (const dir of readdirSync(root)) {
  const d = join(root, dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const rec = JSON.parse(readFileSync(join(d, f), "utf8"));
    const ms: Msg[] = rec.messages ?? [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i] as Msg;
      if (m.role === "system") systems.push(m);
      else if (m.role === "user") prompts.push(m);
      else if (m.role === "assistant") {
        const group = [m];
        let j = i + 1;
        while (j < ms.length && (ms[j] as Msg).role === "tool") group.push(ms[j++] as Msg);
        rounds.push(group);
        i = j - 1;
      }
    }
  }
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const ROUNDS_PER_TURN = 12;

/** Build a session whose compact JSON messages total ~targetBytes (tokens ≈ bytes / 4). */
export function buildSession(targetBytes: number, seed = 1): { messages: Msg[]; steps: Step[] } {
  const rnd = prng(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)] as T;
  // the p90-ish system prompt (the real ones are 2–33 KB)
  const sys = systems.slice().sort((a, b) => a.content.length - b.content.length)[Math.floor(systems.length * 0.9)] as Msg;
  const messages: Msg[] = [sys];
  const steps: Step[] = [];
  let bytes = JSON.stringify(sys).length;
  while (bytes < targetBytes) {
    const p = pick(prompts);
    messages.push(p);
    bytes += JSON.stringify(p).length;
    for (let r = 0; r < ROUNDS_PER_TURN && bytes < targetBytes; r++) {
      const g = pick(rounds);
      for (const m of g) {
        messages.push(m);
        bytes += JSON.stringify(m).length;
      }
      steps.push({ end: messages.length, turnEnd: false });
    }
    const last = steps.at(-1);
    if (last) last.turnEnd = true;
  }
  return { messages, steps };
}

export const poolStats = { rounds: rounds.length, prompts: prompts.length, systems: systems.length };
```

`bench-save.ts`

```ts
// Whole-session save simulation: TODAY (full snapshot read-back + JsonSessionStore with
// the Q6 guard, i.e. the laptop's store) vs JSONL (tail read-back + append/truncate+fsync).
// One save per committed round (fix/run-session-never-saved), the mid-turn ones with the
// closing tail `cutHistory` adds; every round also annotates the previous round's last
// message in place (contextUsage, agent.ts:1156) — the realistic in-epoch mutation.
// Usage: bun bench-save.ts <tokens>   (tokens ≈ compact JSON bytes / 4)
import { mkdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { JsonSessionStore, parseSessionRecord } from "@tentacle/agent";
import { buildSession, type Msg } from "./gen.ts";

const tokens = Number(process.argv[2] ?? 100_000);
const PAGE = 200; // client SNAPSHOT_PAGE (remote-client.ts:119)
const dir = join(import.meta.dir, "out", `save-${tokens}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const { messages: full, steps } = buildSession(tokens * 4, 7);
const live: Msg[] = []; // the daemon's history as it grows (mutated in place like the agent)
const id = "00000000-0000-4000-8000-000000000001";
const store = new JsonSessionStore(join(dir, "json"), undefined, () => {
  throw new Error("aside: the sim must never write a strict prefix");
});
const closing = { role: "assistant", content: "(turn ended before it finished)" };

// the 3-line Q6 comparison (session-store.ts:412, private) — copied verbatim
const dropsHeld = (held: readonly unknown[], incoming: readonly unknown[]): boolean =>
  incoming.length < held.length &&
  incoming.every((m, i) => JSON.stringify(m) === JSON.stringify(held[i]));

type Row = { [k: string]: number };
const json: Row[] = [];
const jsonl: Row[] = [];

// JSONL writer state
mkdirSync(join(dir, "jsonl"), { recursive: true });
const fh = await open(join(dir, "jsonl", `${id}.jsonl`), "w", 0o600);
const offsets: number[] = []; // byte offset where line i starts
let committedEnd = 0; // file length up to the last committed message (tail excluded)
let synced = 0; // messages the laptop already holds (for the tail read-back)
let fileBytesNow = 0;
const enc = new TextEncoder();

let prevEnd = 1;
live.push(full[0] as Msg);
for (const step of steps) {
  // in-place annotation of the previous round's last message (contextUsage)
  const t = live.length - 1;
  const at = live[t];
  if (at && (at.role === "tool" || at.role === "user") && t > 0) {
    live[t] = { ...at, contextUsage: { used: 1000 * t, window: 200_000 } };
  }
  const firstChanged = Math.min(t, prevEnd);
  for (let i = live.length; i < step.end; i++) live.push(full[i] as Msg);
  prevEnd = step.end;
  const record = {
    id, cwd: "/w", model: "m", createdAt: 1, updatedAt: Date.now(), title: "t",
    messages: step.turnEnd ? [...live] : [...live, closing],
  };

  // ---------- TODAY ----------
  {
    // daemon side: page frames (newest first) — built, not timed for the laptop
    const frames: string[] = [];
    for (let end = live.length; end > 0; end -= PAGE) {
      const start = Math.max(0, end - PAGE);
      frames.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { messages: live.slice(start, end) } }));
    }
    let t0 = performance.now();
    for (const f of frames) JSON.parse(f);
    const wireParse = performance.now() - t0;
    const wireBytes = frames.reduce((a, f) => a + Buffer.byteLength(f), 0);
    // sync work the store does inside save(): Q6 load parse+validate+compare, then stringify
    let guard = 0;
    if (fileBytesNow > 0) {
      const text = await Bun.file(join(dir, "json", `${id}.json`)).text();
      t0 = performance.now();
      const v = JSON.parse(text);
      const p = parseSessionRecord(v, id);
      if (p.ok) dropsHeld(p.record.messages, record.messages);
      guard = performance.now() - t0;
    }
    t0 = performance.now();
    const out = `${JSON.stringify(record, null, 2)}\n`;
    const stringify = performance.now() - t0;
    t0 = performance.now();
    await store.save(record); // the REAL store: guard + stringify + write + fsync + rename
    const saveWall = performance.now() - t0;
    fileBytesNow = Buffer.byteLength(out);
    json.push({ wireParse, wireBytes, pages: frames.length, guard, stringify, saveWall, diskBytes: fileBytesNow,
      syncCpu: wireParse + guard + stringify });
  }

  // ---------- JSONL ----------
  {
    // tail read-back: everything from the first changed index (one frame)
    const tail = live.slice(Math.min(firstChanged, synced));
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { from: Math.min(firstChanged, synced), messages: tail } });
    let t0 = performance.now();
    JSON.parse(frame);
    const wireParse = performance.now() - t0;
    const from = Math.min(firstChanged, synced);
    t0 = performance.now();
    const lines = live.slice(from).map((m) => `${JSON.stringify(m)}\n`).join("");
    const tailLine = step.turnEnd ? "" : `${JSON.stringify(closing)}\n`;
    const stringify = performance.now() - t0;
    t0 = performance.now();
    const cut = from < offsets.length ? (offsets[from] as number) : committedEnd;
    await fh.truncate(cut);
    const body = enc.encode(lines);
    await fh.write(body, 0, body.length, cut);
    offsets.length = from;
    let o = cut;
    for (let i = from; i < live.length; i++) {
      offsets.push(o);
      o += Buffer.byteLength(JSON.stringify(live[i])) + 1;
    }
    committedEnd = cut + body.length;
    const tb = enc.encode(tailLine);
    if (tb.length) await fh.write(tb, 0, tb.length, committedEnd);
    await fh.sync();
    const saveWall = performance.now() - t0;
    synced = live.length;
    jsonl.push({ wireParse, wireBytes: Buffer.byteLength(frame), pages: 1, guard: 0, stringify, saveWall,
      diskBytes: body.length + tb.length, syncCpu: wireParse + stringify });
  }
}
await fh.close();

const q = (rows: Row[], k: string, p: number) => {
  const a = rows.map((r) => r[k] as number).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))] as number;
};
const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + (r[k] as number), 0);
const last = (rows: Row[]) => rows.slice(Math.floor(rows.length * 0.9)); // the session at ~full size
const finalBytes = Buffer.byteLength(JSON.stringify(live));
console.log(`tokens≈${tokens} msgs=${live.length} saves=${steps.length} final compact=${(finalBytes / 1e6).toFixed(2)}MB`);
for (const [name, rows] of [["TODAY", json], ["JSONL", jsonl]] as const) {
  console.log(
    `${name.padEnd(5)} syncCPU/save p50=${q(rows, "syncCpu", 0.5).toFixed(2)}ms p99=${q(rows, "syncCpu", 0.99).toFixed(2)}ms ` +
      `last10%p50=${q(last(rows), "syncCpu", 0.5).toFixed(2)}ms | ` +
      `wireParse last10%p50=${q(last(rows), "wireParse", 0.5).toFixed(2)} guard=${q(last(rows), "guard", 0.5).toFixed(2)} stringify=${q(last(rows), "stringify", 0.5).toFixed(2)} | ` +
      `saveWall p50=${q(rows, "saveWall", 0.5).toFixed(2)} p99=${q(rows, "saveWall", 0.99).toFixed(2)}ms | ` +
      `disk total=${(sum(rows, "diskBytes") / 1e6).toFixed(1)}MB wire total=${(sum(rows, "wireBytes") / 1e6).toFixed(1)}MB ` +
      `wire/save last10%p50=${(q(last(rows), "wireBytes", 0.5) / 1e3).toFixed(1)}KB pages=${q(last(rows), "pages", 0.5)}`,
  );
}
```

`fsync.mjs`

```js
// fsync cost: whole-file rewrite (tmp + write + fsync + rename, as JsonSessionStore) vs
// append ~2.7 KB + fsync (JSONL). Runs under node (Linux container) and bun (macOS host).
// Usage: node fsync.mjs <dir>
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "/tmp/fsync-bench";
mkdirSync(dir, { recursive: true });
const N = 60;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const mb of [0.4, 2, 4]) {
  const buf = Buffer.alloc(Math.round(mb * 1e6), 97);
  const t = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const tmp = join(dir, `.s.json.tmp-${i}`);
    const fd = openSync(tmp, "w", 0o600);
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, join(dir, "s.json"));
    t.push(performance.now() - t0);
  }
  console.log(`rewrite ${mb}MB: p50=${q(t, 0.5).toFixed(2)}ms p99=${q(t, 0.99).toFixed(2)}ms`);
}
const line = Buffer.alloc(2700, 98);
const fd = openSync(join(dir, "s.jsonl"), "a", 0o600);
const t = [];
for (let i = 0; i < N * 5; i++) {
  const t0 = performance.now();
  writeSync(fd, line);
  fsyncSync(fd);
  t.push(performance.now() - t0);
}
closeSync(fd);
console.log(`append 2.7KB: p50=${q(t, 0.5).toFixed(2)}ms p99=${q(t, 0.99).toFixed(2)}ms`);
```

`bench-list.ts`

```ts
// `--resume` picker cost: JsonSessionStore.list() parses EVERY file whole (session-store.ts:648-682).
// 200 synthetic sessions whose sizes follow the real distribution (shapes.ts) vs reading
// only a small metadata header per file (what a JSONL header line / sidecar would allow).
import { mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { buildSession } from "./gen.ts";

const root = `${process.env.HOME}/.config/tentacle/sessions`;
const real: number[] = [];
for (const d of readdirSync(root)) {
  const p = join(root, d);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith(".json")) real.push(statSync(join(p, f)).size);
}
const dir = join(import.meta.dir, "out", "list");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new JsonSessionStore(dir);
let total = 0;
for (let i = 0; i < 200; i++) {
  const size = real[(i * 7919) % real.length] as number;
  const { messages } = buildSession(size / 1.055, i + 1);
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  await store.save({ id, cwd: "/w", model: "m", createdAt: i, updatedAt: i, title: "t", messages });
  total += size;
}
console.log(`200 sessions, ${(total / 1e6).toFixed(1)}MB on disk`);
for (let run = 0; run < 3; run++) {
  let t0 = performance.now();
  const { records } = await new JsonSessionStore(dir).list();
  const full = performance.now() - t0;
  t0 = performance.now();
  const buf = Buffer.alloc(4096);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const fd = openSync(join(dir, f), "r");
    readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
  }
  const head = performance.now() - t0;
  console.log(`run ${run}: list() ${full.toFixed(0)}ms (${records.length} records) · header-only read ${head.toFixed(1)}ms`);
}
```

`crash.ts`

```ts
// Crash/corruption semantics. (1) a child SIGKILLed while appending JSONL lines in a loop:
// what does the file end with? (2) one flipped byte mid-file: whole-JSON vs JSONL recovery.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSession } from "./gen.ts";

const out = join(import.meta.dir, "out", "crash");
rmSync(out, { recursive: true, force: true });
Bun.spawnSync(["mkdir", "-p", out]);
const { messages } = buildSession(2_000_000, 3);
const lines = messages.map((m) => `${JSON.stringify(m)}\n`);
writeFileSync(join(out, "lines.json"), JSON.stringify(lines));

// (1) appender: one write() per line, unbuffered; SIGKILLed after 400 ms
const file = join(out, "s.jsonl");
const child = spawn("bun", ["-e", `
  const fs = require("node:fs");
  const lines = JSON.parse(fs.readFileSync(${JSON.stringify(join(out, "lines.json"))}, "utf8"));
  const fd = fs.openSync(${JSON.stringify(file)}, "a");
  for (;;) for (const l of lines) fs.writeSync(fd, l);
`]);
await Bun.sleep(400);
child.kill("SIGKILL");
await new Promise((r) => child.on("exit", r));
const text = readFileSync(file, "utf8");
const parts = text.split("\n");
const torn = parts.at(-1) !== "";
let good = 0, bad = 0;
for (const p of parts.slice(0, -1)) {
  try { JSON.parse(p); good++; } catch { bad++; }
}
console.log(`SIGKILL mid-append: ${(text.length / 1e6).toFixed(1)}MB, complete lines ok=${good} bad=${bad}, last line torn=${torn} (${parts.at(-1)?.length} chars)`);

// (2) one corrupted byte in the middle
const whole = JSON.stringify({ messages }, null, 2);
const mid = Math.floor(whole.length / 2);
const flipped = `${whole.slice(0, mid)}\u0000${whole.slice(mid + 1)}`;
let wholeOk = true;
try { JSON.parse(flipped); } catch { wholeOk = false; }
const jl = lines.join("");
const jm = Math.floor(jl.length / 2);
const jflip = `${jl.slice(0, jm)}\u0000${jl.slice(jm + 1)}`;
let ok = 0, ko = 0;
for (const l of jflip.split("\n").slice(0, -1)) { try { JSON.parse(l); ok++; } catch { ko++; } }
console.log(`1 corrupted byte: whole JSON parses=${wholeOk} · JSONL lines ok=${ok} bad=${ko} of ${lines.length}`);
```

### Scripts, round 2

`pi-shape.ts`

```ts
// Shape of the owner's pi session log: per line, type + keys (content elided), id/parentId chain.
import { readFileSync } from "node:fs";

const text = readFileSync(`${import.meta.dir}/pi-agent-sample.jsonl`, "utf8");
const lines = text.split("\n").filter((l) => l !== "");
const parents = new Map<string, string | null>();
for (const [i, l] of lines.entries()) {
  const e = JSON.parse(l);
  const keys = Object.keys(e).filter((k) => !["type", "id", "parentId", "timestamp"].includes(k));
  const inner = e.message ? ` message{${Object.keys(e.message).join(",")}} role=${e.message.role}` : "";
  const extra = Object.fromEntries(
    keys.filter((k) => k !== "message").map((k) => [k, typeof e[k] === "string" && e[k].length > 60 ? `${e[k].slice(0, 60)}…` : e[k]]),
  );
  console.log(`${i} ${e.type} id=${e.id} parent=${e.parentId} bytes=${l.length}${inner} ${JSON.stringify(extra).slice(0, 220)}`);
  if (e.id) parents.set(e.id, e.parentId ?? null);
}
const children = new Map<string | null, number>();
for (const p of parents.values()) children.set(p, (children.get(p) ?? 0) + 1);
console.log(`branch points: ${[...children.entries()].filter(([, n]) => n > 1).length}`);
```

`bench-eventlog.ts`

```ts
// Event-log model (pi-like): typed entries {type, seq, ...}. Measures, per session size:
//  - log size vs today's pretty JSON record
//  - load = read + parse every line + replay into the model projection (messages[]),
//    with N in-place edits (`message_replace`, one per round, like contextUsage) and
//    K compactions (a `compaction` entry; the projection restarts from its summary)
//  - load that seeks to the last compaction via a footer/checkpoint offset (skip parse before it)
//  - listing: read only the last 16 KB of each file (latest `meta` checkpoint) vs whole parse
// Usage: bun bench-eventlog.ts <tokens> <compactions>
import { mkdirSync, rmSync, writeFileSync, readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSession, type Msg } from "./gen.ts";

const tokens = Number(process.argv[2] ?? 500_000);
const compactions = Number(process.argv[3] ?? 0);
const dir = join(import.meta.dir, "out", `eventlog-${tokens}-${compactions}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// The log holds (compactions + 1) epochs of `tokens` each: a compaction does NOT drop older entries.
const lines: string[] = [];
let seq = 0;
const ts = 1_790_000_000_000;
const push = (e: Record<string, unknown>) => lines.push(JSON.stringify({ seq: ++seq, ts: ts + seq, ...e }));
push({ type: "session", version: 1, id: "s", cwd: "/w", critical: true });
push({ type: "model_change", provider: "p", model: "m" });
let lastEpochProjection: Msg[] = [];
let compactionOffsets: number[] = [];
for (let epoch = 0; epoch <= compactions; epoch++) {
  const { messages, steps } = buildSession(tokens * 4, 11 + epoch);
  const projection: Msg[] = [];
  const seqOf: number[] = [];
  if (epoch > 0) {
    compactionOffsets.push(lines.length);
    push({ type: "compaction", summary: "summary of the earlier conversation ".repeat(60), critical: true });
  }
  let i = 0;
  for (const step of steps) {
    // in-place annotation of the previous round's last message, as an edit entry
    const t = projection.length - 1;
    if (t > 0 && (projection[t]?.role === "tool" || projection[t]?.role === "user")) {
      push({ type: "message_replace", target: seqOf[t], patch: { contextUsage: { used: 1000 * t, window: 200_000 } }, critical: true });
    }
    for (; i < step.end; i++) {
      push({ type: "message", message: messages[i] });
      seqOf.push(seq);
      projection.push(messages[i] as Msg);
    }
    if (step.turnEnd) {
      push({ type: "usage", promptTokens: 12345, completionTokens: 678 });
      push({ type: "meta", title: "t", updatedAt: ts + seq, messages: projection.length });
    }
  }
  lastEpochProjection = projection;
}
const text = `${lines.join("\n")}\n`;
writeFileSync(join(dir, "s.jsonl"), text);
const jsonToday = `${JSON.stringify({ id: "s", messages: lastEpochProjection }, null, 2)}\n`;
const edits = lines.filter((l) => l.includes('"type":"message_replace"')).length;

function replay(src: string, startLine = 0): Msg[] {
  const ls = src.split("\n");
  let msgs: Msg[] = [];
  const index = new Map<number, number>();
  for (let k = startLine; k < ls.length; k++) {
    const l = ls[k] as string;
    if (l === "") continue;
    const e = JSON.parse(l);
    switch (e.type) {
      case "message":
        index.set(e.seq, msgs.length);
        msgs.push(e.message);
        break;
      case "message_replace": {
        const at = index.get(e.target);
        if (at !== undefined) msgs[at] = { ...(msgs[at] as Msg), ...e.patch };
        break;
      }
      case "compaction":
        msgs = [{ role: "user", content: e.summary }];
        index.clear();
        break;
      case "session": // header: version checked here in a real reader
        break;
      default:
        if (e.critical) throw new Error(`unknown critical entry ${e.type}`);
    }
  }
  return msgs;
}
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] as number;
const full: number[] = [];
const seek: number[] = [];
const today: number[] = [];
for (let r = 0; r < 7; r++) {
  let t0 = performance.now();
  replay(readFileSync(join(dir, "s.jsonl"), "utf8"));
  full.push(performance.now() - t0);
  t0 = performance.now();
  const startLine = compactionOffsets.at(-1) ?? 0;
  replay(readFileSync(join(dir, "s.jsonl"), "utf8"), startLine); // (a footer would give this offset)
  seek.push(performance.now() - t0);
  t0 = performance.now();
  JSON.parse(jsonToday);
  today.push(performance.now() - t0);
}
// listing: last 16 KB, find the latest meta line
const st = statSync(join(dir, "s.jsonl"));
const buf = Buffer.alloc(16384);
let t0 = performance.now();
for (let r = 0; r < 200; r++) {
  const fd = openSync(join(dir, "s.jsonl"), "r");
  readSync(fd, buf, 0, buf.length, Math.max(0, st.size - buf.length));
  closeSync(fd);
  const tail = buf.toString("utf8").split("\n");
  for (let k = tail.length - 1; k >= 0; k--) if (tail[k]?.includes('"type":"meta"')) { JSON.parse(tail[k] as string); break; }
}
const list200 = performance.now() - t0;
console.log(
  `tokens/epoch≈${tokens} compactions=${compactions} entries=${lines.length} edits=${edits} ` +
    `log=${(text.length / 1e6).toFixed(2)}MB vs today's record=${(jsonToday.length / 1e6).toFixed(2)}MB | ` +
    `load: replay-all p50=${q(full, 0.5).toFixed(1)}ms · replay-from-last-compaction p50=${q(seek, 0.5).toFixed(1)}ms · today JSON.parse p50=${q(today, 0.5).toFixed(1)}ms | ` +
    `listing 200 × tail-16KB=${list200.toFixed(1)}ms`,
);
```

`append-race.ts`

```ts
// Several writers of ONE log (several TUIs of a detached run): each appends whole lines with
// O_APPEND, one write() per line, concurrently. Are lines ever interleaved/torn? Duplicates
// (both writers append the same daemon seq) are expected and removed by seq on replay.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "out", "race");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = join(dir, "s.jsonl");
const WRITERS = 4;
const N = 3000;
const body = "x".repeat(Number(process.argv[2] ?? 3000)); // ~a real round entry; try 70000 too
const kids = Array.from({ length: WRITERS }, (_, w) =>
  spawn("bun", ["-e", `
    const fs = require("node:fs");
    const fd = fs.openSync(${JSON.stringify(file)}, "a");
    for (let s = 1; s <= ${N}; s++) fs.writeSync(fd, JSON.stringify({ seq: s, w: ${w}, body: ${JSON.stringify(body)} }) + "\\n");
  `]),
);
await Promise.all(kids.map((k) => new Promise((r) => k.on("exit", r))));
const lines = readFileSync(file, "utf8").split("\n").slice(0, -1);
let bad = 0;
const seqs = new Set<number>();
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    if (e.body.length !== body.length) bad++;
    seqs.add(e.seq);
  } catch {
    bad++;
  }
}
console.log(`writers=${WRITERS} lines=${lines.length} (expected ${WRITERS * N}) line=${body.length}B torn/interleaved=${bad} distinct seqs after dedupe=${seqs.size}`);
```

`bench-diff.ts`

```ts
// Daemon-side derivation of log entries at a commit: compare session.messages with the array of
// references seen at the previous commit (messages are readonly → a change REPLACES the element).
// Cost per commit at 1M tokens (3377 messages), with one replaced element + new tail.
import { buildSession, type Msg } from "./gen.ts";

const { messages } = buildSession(4_000_000, 5);
const live = messages.slice(0, messages.length - 3);
const seen = live.slice();
live[live.length - 2] = { ...(live[live.length - 2] as Msg), contextUsage: { used: 1, window: 2 } };
live.push(...messages.slice(messages.length - 3));
const times: number[] = [];
let out: { replaced: number[]; appended: number } = { replaced: [], appended: 0 };
for (let r = 0; r < 2000; r++) {
  const t0 = performance.now();
  const replaced: number[] = [];
  const n = Math.min(seen.length, live.length);
  for (let i = 0; i < n; i++) if (live[i] !== seen[i]) replaced.push(i);
  out = { replaced, appended: live.length - n };
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(`messages=${live.length} replaced=${out.replaced} appended=${out.appended} per-commit diff p50=${(times[1000] as number * 1000).toFixed(1)}µs p99=${(times[1980] as number * 1000).toFixed(1)}µs`);
```

### Limits of these measurements

- The k8s wire time is computed from the link figures measured in
  `rpc-flow-control.md`, not run end to end (no cluster here). Those figures
  are round-trip echo throughput, so one-way read-back may be somewhat faster.
- Linux fsync not measured (command above).
- One save per round is the upper bound; the saver's coalescing lowers it when
  rounds are faster than a read-back.
- Daemon-side costs (page `JSON.stringify` in the pod, `serve` rewrites) are
  derived from the same per-size numbers and the call-site count, not measured
  in a running daemon.

## Review

*— claude-opus-5-5, 2026-11-07 (round 2)*

### Verdict, round 2 (supersedes round 1 where they differ)

| Option | Verdict | Deciding numbers |
|---|---|---|
| **(A) incremental read-back** | **BUILD — in the log's shape (A-as-log), not as `base {epoch, rev}`** | per save at 500k tokens 1.96 MB / 8 RTT → 2.6 KB / 1 RTT; ~1.1–1.7 s of k8s link per round → ~0.05 s. A-plain would be replaced by the log within a month, and mobile task 12 would be built on it in between: two migrations instead of one |
| **(B-plain JSONL)** | **NO** (unchanged) | without events every round-1 objection stands; disk cost invisible (save ≤ 7 ms async at 1M) |
| **(B-event-log)** | **BUILD, after (A-as-log): laptop first, `serve` second** | every round-1 objection resolved and measured: edits +2.2 ms replay at 1M (7.4 vs 5.2 ms); diff 5 µs/commit; 4 writers 0 torn lines; listing 4.5 ms/200. Gains no rewrite format can give: the pre-compaction transcript kept (today lost), skip-and-keep forward compatibility, the Q6 guard gone, wire = disk = mobile cache. Disk 807 MB → ~3 MB per 500k session as a side effect |
| **(C) typed entries** | **YES — as the log's entry schema (task 1)**; NOT alone in today's JSON | in JSON an unknown type must still be refused and the most valuable fact (pre-compaction transcript) still cannot be kept; in the log it costs nothing extra and gets the `critical`-flag rule |

Combinations: (A-as-log) alone is already worth it (all wire wins, the format
fixed once). (B-event-log) without (A-as-log) is not: the laptop would append
lines it had to rebuild from full read-backs. (C) without the log is the
weakest option. **Recommended path: A-as-log (with C) → laptop log → serve
log.**

Cost now vs in a month: today nothing is persisted in the log format, there
are no external peers, and mobile has no cache (`apps/mobile/src` is a spike).
In a month mobile tasks 12–13 build their transcript cache and sync on
whatever read primitive exists; changing it then is a protocol + a phone-side
store migration. Pre-public, the version bumps cost nothing.

### Task split (round 2)

1. **`feat/session-log`** — protocol entry schema (C) + `session/log {after}`
   + daemon derivation and seq (+ pod reseed in `open`) + client `readBack` on
   the log + checkpoint verification. The laptop still writes today's JSON
   projection. **L · load-bearing** (protocol, the TUI-over-RPC session path,
   persistence invariant). Strong model, mandatory fresh-context Review.
   Replaces the paged `snapshot` for history (`PROTOCOL_VERSION` bump).
2. **`feat/session-log-laptop-store`** — `<uid>.jsonl`, loader, listing, Q6
   removal, resume/attach paths; AGENTS §7 persistence wording updated (the
   rule change rides this branch, §10 carve-out (c)). **M · load-bearing.**
3. **`feat/session-log-serve-store`** — daemon log + state sidecar, reload,
   archive; `DAEMON_RECORD_VERSION` replaced by the log header version.
   **M–L · load-bearing.** Can wait for a measured need (Linux fsync, disk),
   but leaves two formats until done.
4. Mobile task 12 builds its cache on (1)'s `log {after}` — recorded in
   `docs/eval/mobile-app.md`.

`fix/run-session-never-saved` is already on `main`; task 1 can start now.
Order is strict (one code task at a time, AGENTS §10).

### Owner questions, round 2 (all at once; each with my recommendation)

1. **Build (A) in the log's shape (task 1, L · load-bearing) instead of the
   plain `base {epoch, rev}` (M)?** — Yes: one migration instead of two;
   mobile gets its primitive.
2. **Adopt the typed event log on the laptop (task 2) after task 1?** —
   Yes.
3. **Also on the `serve` daemon (task 3), now or on a measured trigger?** —
   Now, right after task 2 (one format everywhere); if the owner prefers to
   wait, the trigger is a measured Linux fsync or disk cost.
4. **(C): typed entries only inside the log, not in today's JSON?** — Yes.
5. **Unknown entries: a per-entry `critical` flag (unknown + critical →
   refuse loudly; otherwise skip and keep), plus a header `version` for
   changed meanings?** — Yes.
6. **Replace the §7 sentence "Persist only `ChatMessage`s — never
   rendering-only events" with the "durable facts" wording proposed in
   Context (incl. "a persisted entry is never authoritative for
   permissions")?** — Yes, on task 2's branch (a rule change, not the
   carve-out).
7. **v1 entry types: the list in the round 2 Implementation sketch; sub-agent
   runs and permission decisions deferred?** — Yes; add them when a reader
   needs them (they are non-critical, so adding later is free).
8. **Keep the pre-compaction transcript in the log (files grow across
   compactions: 5 × 200k tokens = 5.4 MB), with no automatic pruning?** —
   Yes, consistent with "nothing is ever purged automatically"
   (session-archive).
9. **Branches (pi's `parentId` tree): include `parentId` now, or a linear
   `seq` only?** — Linear `seq` only: no tentacle feature forks a session
   today; a `fork` entry can add it later as a non-critical type.
10. **Daemon suspended-turn state as a small whole-file sidecar, not as
    events?** — Yes: it is KBs, and re-expressing it as events re-opens
    `suspended-turn-resume` for no gain.
11. **Run the Linux measurements (fsync, `O_APPEND` concurrency) in a
    `node:22` container before task 3?** — Yes, before task 3 only; they
    cannot change tasks 1–2.

### Round 1 verdict (superseded where the table above differs)

**(A) incremental read-back: BUILD.** Deciding numbers: per save at 500k
tokens, 1.96 MB in 8 round trips → 2.6 KB in 1 (whole session 757 MB →
3.2 MB); on the measured k8s exec link that is ~1.1–1.7 s of link occupancy
per round, ahead of the live stream, down to ~0.05 s. The cost grows with
every round now that saves are per round, and the mobile app needs the same
primitive to catch up after an app kill. Cost: M, additive protocol field, no
version bump, a full-read fallback on every divergence.

**(B) JSONL on disk: DO NOT BUILD (now).** It wins on bytes written (807 MB →
3 MB per 500k session) but that cost is invisible: a whole save, fsync
included, is 3.4 ms p50 at 500k and ≲ 7 ms at 1M, async; the largest blocking
CPU stretch is ≲ 10 ms even at 1M tokens (under one frame) and ≲ 3 ms at real
record sizes (≤ 1.4 MB); listing is 75 ms once. Against that: the history is
not append-only within an epoch, both record kinds carry mutable state
rewritten at every write, several TUIs write one uid, and the strict parsers
and the Q6 guard would be rebuilt — an L, load-bearing change with new failure
modes, for no user-visible gain.

- **B without A:** no — the dominant cost (wire) stays.
- **A without B:** yes — it captures every measured user-visible win.
- **Both:** no reason today. Revisit (B) only if a trigger fires: records
  routinely > 10 MB (1M-window models without compaction), a measured Linux
  `serve` fsync cost that matters, or a laptop frame hitch traced to a save.

### Round 1 task split (superseded by the round 2 split)

One task, `feat/snapshot-incremental` · **M · load-bearing** (protocol + the
TUI-over-RPC session path + the persistence invariant) · strong model executes,
mandatory fresh-context Review. Dependency order: protocol → daemon → client
→ cli. `fix/run-session-never-saved` is already on `main`, so it can start
now. Not splitting: the daemon half is useless without its reader.

### Round 1 owner questions (superseded by the round 2 list)

1. **Approve (A) as `feat/snapshot-incremental` (M · load-bearing)?** — Yes.
2. **Reject (B) now, with the three revisit triggers above recorded in
   `TODO.md`?** — Yes.
3. **Detecting in-epoch changes: daemon-side rev per index via reference
   identity (exact, O(n) pointer compares), rather than client hashes or
   "everything after my length"?** — Daemon-side rev. "After my length" misses
   the system-head swap and the `contextUsage` annotation (measured shapes in
   this doc); client hashes cost a stringify per message.
4. **Protocol shape: optional `base` / `from` fields, no `PROTOCOL_VERSION`
   bump (an older daemon ignores `base`, the client falls back to a full
   read)?** — Yes, additive. Pre-public allows a bump, but nothing here needs
   one.
5. **Run the Linux fsync measurement (one `docker run node:22`, command in
   M3) before closing the eval?** — Optional: it can only make (B)'s disk
   cost look worse, so it cannot flip the verdict.
6. **Mobile: name (A)'s `base {epoch, rev}` as the catch-up primitive of
   mobile task 12 in `docs/eval/mobile-app.md`, so the app's cache is designed
   on it rather than on full reads?** — Yes.

## Review (fresh context)

*— claude-opus-5-5, 2026-11-07 (fresh reviewer)*

Reviewer: the same model as the author (fresh context only), so blind spots the
two passes share can survive. Eval, no code: `bun run check` does not apply and
was not run. Scratch: `review/` (`wire.ts`, `race.ts`, `splice.ts`,
`replay.ts`), same generator (`../gen.ts`), so the numbers are comparable.

### Verdict

**REQUEST-CHANGES on round 2's path.** Round 1's (A) holds, and the numbers
reproduce. Round 2's flip to "A-as-log → laptop log → serve log" does not hold
up. Its one measured user-visible win, the wire, is equally won by A-plain. Its
other wins are invisible (disk), or features with no reader yet (the
pre-compaction transcript, usage, settings), or false as stated (the "Q6 guard
becomes unnecessary" claim; see F1). It also leaves four design gaps open
(F1–F4). **Recommended path: A-plain now (M). Keep the compacted segments in a
small append-only archive (S) if the owner wants them. Defer the event log
behind named triggers.**

### Numbers re-run

| Claim | Re-run | Status |
|---|---|---|
| Wire/save at 500k: 1.96 MB, 8 pages; total 757 MB; tail 2.6 KB | `wire.ts 500000`: 1956 KB, 8 pages, 756 MB; tail 2.5 KB, total 3.2 MB | **reproduced** |
| Replay at 1M with one edit per round: 7.4 ms vs 5.2 ms JSON.parse | `replay.ts 1000000 0`: 7.5 ms vs 5.6 ms, 0 orphan edits | **reproduced**. Both are lower bounds: neither path validates (no strict schema parse) |
| 5 × 200k compactions: log 5.36 MB, replay 9.0 ms | `replay.ts 200000 5`: 5.29 MB, 8.9 ms (today 1.1 ms) | **reproduced** |
| 4 writers, 0 torn lines (3 KB, 70 KB) | `race.ts`: 0 torn at 3 KB×4, 70 KB×4, **1 MB×8, 8 MB×8**; 0 short writes | **reproduced and extended**, but it measures a weaker property, see below |
| M2 k8s link time 1.1–1.7 s/round at 500k | not re-runnable here (no cluster) | **estimate**. It is the ONLY user-visible number behind (A), and it is derived, not measured end to end |
| Listing 75 ms vs 4.5 ms | not re-run (pre-mount, ~75 ms once, decides nothing) | — |

**The torn-line test (M7) on APFS.** PIPE_BUF (512 B on macOS) bounds atomicity
for pipes and FIFOs, not for regular files. For a regular file, POSIX only
makes the `O_APPEND` seek-to-end atomic with the write. Whole-write
non-interleaving is observed kernel behaviour, not a guarantee. So the test IS
meaningful as an empirical check on this kernel, up to 8 MB a line. Two things
are untested: Bun's async `FileHandle.write` (the test uses `writeSync`), and
Linux. But a test can show "every line is intact" and still miss the property
the claim needs, "the replayed projection is a history some daemon actually
had" (AGENTS §2). That second property fails: see F1.

### Premise table (spot-checked)

| # | Citation | Status |
|---|---|---|
| 1 | `agent.ts:950` commits after an assistant message with calls | TRUE |
| 2 | `agent.ts:1009` `pop()` of an empty round is never behind a cut (no commit for a call-less round, :950) | TRUE |
| 3 | `agent.ts:1156` contextUsage REPLACES a message behind the cut | TRUE |
| 4 | `session.ts:87-95` `replaceAgent` swaps `messages[0]` in place | TRUE |
| 5 | `remote-client.ts:119` `SNAPSHOT_PAGE = 200`; `:2125` result cast, not validated | TRUE |
| 6 | `hosted-session.ts:1074` `snapshotPage`; `:1930-1950` new random epoch on a replacement | TRUE |
| 7 | `hosted-session.ts:1512-1522` `recordCut` + `persist` at every `history_commit` | TRUE |
| 8 | `session-store.ts:412-417` `dropsHeld` = strict prefix only; `:506-507` guard when `onAside` is set | TRUE |
| 9 | `local-runtime.ts:445` flushes at every `tool_result` | TRUE |
| 10 | `persisted-session.ts:53` `DAEMON_RECORD_VERSION = 8`; `serve.ts:122` same `JsonSessionStore` | TRUE |
| 11 | `apps/mobile/src` is a spike (`rn-websocket.ts`, `spike.ts`), no snapshot use | TRUE |
| 12 | "Every in-epoch change" inventory (Context) | **INCOMPLETE**: `closeFailedTurn` (`persisted-session.ts:537-546`, called at `hosted-session.ts:1569`) REPLACES the last assistant message when a turn fails. Compaction (`session.ts:239`) and reset (`agent.ts:1763`) clear the SAME array in place (`length = 0; push`) |
| 13 | "mobile task 12 builds its cache" | **PARTIAL**: task 12 is "Live transcript, L · contained" (`mobile-app.md:328`). The offline cache is a v1 scope item (`:181`) with no task of its own. Tasks 9–11 come first; only 8 is done (`TODO.md:1156`) |
| 14 | "format migration of users' files (pre-public today: none)" | **FALSE**: 173 JSON records exist under `~/.config/tentacle` today |
| 15 | "Q6 guard and asides become unnecessary" | **FALSE**: F1 |

### Findings

**F1 (high) — seq dedupe splices two daemon incarnations silently.** The
replay rule is "apply `seq == applied+1`, skip `≤ applied`". Scenario: TUI A is
on pod daemon D1, and D1 dies. TUI B reopens D2, reseeded from the laptop log at
seq 48. A has not yet flushed 49–50, and does so late. `splice.ts` shows the
result:

```
D2 first, A late: tail=D2:D2-m49 | D2:D2-m50 | D2:D2-m51  (mixed incarnations=false)
A late first, then D2: tail=D1:D1-m49 | D1:D1-m50 | D2:D2-m51  (mixed incarnations=true)
```

Order 1 drops D1's 49–50 silently. Order 2 builds a history no daemon ever
had: D2's 51 on top of D1's 49–50. Today, last-rename-wins at least keeps the
whole record from one writer, and Q6 sets a stale prefix aside. The log is
strictly worse here unless every entry carries lineage: an incarnation id plus
the previous entry's hash, so a fork is detected and set aside, never spliced.
That chain is exactly pi's `parentId`. **Round 2's Q9 ("linear seq only, no
parentId") is therefore wrong**: the chain is needed for integrity, not for
branches.

**F2 (high) — the `meta {messages, lastHash}` checkpoint cannot catch the
failure it exists for.** The derivation risk is a missed IN-PLACE edit behind
the end (head swap at index 0, contextUsage, `closeFailedTurn`). A count plus
the last message's hash passes on any of them. A sound check hashes the whole
projection: measured at **6.6 ms at 1M tokens** per checkpoint
(`replay.ts`), or an incremental per-entry chain (F1's chain gives this for
free). Also, the hash comes from the pod. That is fine for detecting drift but
it is not security. The doc calls it "verification" without saying that.

**F3 (medium) — the reference diff, as measured (M8), handles only "replaced +
appended".** In `bench-diff.ts`, `appended = live.length - min(...)`, so a
shrink yields 0 and the removed tail is lost silently. The v1 entry list has no
removal type. Today nothing shrinks behind a cut (premise 2). But compaction and
reset reuse the SAME array (premise 12), so the derivation must be driven by
`historyReplaced` and must reset its reference copy there. Any future in-place
truncation, such as a pi-style `context_edit`, would be a silent loss. Who is
the source of truth also flips in task 3: on reload the log's projection BECOMES
the agent's history. So a derivation bug is no longer a stale display. It
becomes a permanent change to what the model sees, which raises the bar on F2.

**F4 (medium) — trust: "append the received lines verbatim" plus
"skip-and-keep unknown non-critical".** Together they let a pod plant entries
on the laptop that TODAY's build skips and a FUTURE build interprets
(`docs/eval/remote-execution-model.md`: pod-supplied data). Today's laptop also
writes pod content unvalidated (`save` does not parse; `load` is strict at
`session-store.ts:636`), but it refuses the whole record loudly on load. The
log rule turns that into "silently kept for later". Required: the laptop writes
only KNOWN, validated, re-serialized entries and drops unknown types from a pod.
That puts back the stringify that "wire = disk, verbatim" removed (small, a few
KB per save). Skip-and-keep then only helps files a trusted writer produced.

**F5 (medium) — a cold reader gets worse.** "`log {after: 0}` for a cold
reader" downloads every kept epoch. In `wire.ts 500000 5` that is ≈ 12.3 MB
against today's 2.05 MB snapshot (6×, on the k8s link that (A) exists to
relieve). The log needs a "start at the last compaction" read and a seek
offset. Daemon memory also grows across epochs if it "keeps the session's
entries in memory". Neither is in the sketch.

**F6 (low) — migration is not "none".** 173 records exist. Converting is
lossless (a record is a projection: header + `message` entries + `meta`) and
size S, but it is code. "Drop" loses the owner's history. Decide it.

**F7 (low) — "two migrations instead of one" is not quantified, and it can be
avoided.** Mobile has zero code on any read primitive (premise 11), and its
cache task is ≥ 3 tasks away (premise 13). So the second migration happens only
if (i) the log is EVER built and (ii) the phone ships on A-plain first. Its size
is one wire change on the laptop↔daemon pair, pre-public, with a version bump
that costs nothing. The diff core (reference compare, full-read fallback, the
validation of a tail) carries over into a log, so what gets thrown away is
roughly `base/from/rev` plus `changedAt`: a fraction of an M. Weighing it: an L
now (A-as-log, with F1–F5 added it is a firm L) against an M now plus maybe a
small re-plumb later. The disk migration (F6) is paid once on either path,
only if the log is built.

**F8 (low) — mobile does not need events.** What v1 needs (`mobile-app.md:145,
181`) is "show the last cached transcript, catch up cheaply". A projection
cache plus `{epoch, rev}` → `{from, messages}` is exactly that. The phone
connects to `serve` (trusted), renders the projection, and has no use for edit
or usage events or the pre-compaction epochs in v1.

### Attacks tried

1. Re-derived the wire bytes at 500k → matched to within 0.1 %. Nothing found.
2. Torn lines at 8 MB × 8 writers → 0. The claim holds empirically on APFS;
   the property it proves is too weak (F1).
3. Seq-dedupe across a daemon restart → silent splice (F1).
4. Searched every in-place history mutation
   (`messages.(pop|splice)|length = |messages[i] =`) → one replacement site
   missing from the inventory, plus same-array clears (premise 12, F3).
5. Checkpoint against a missed mid-history edit → passes undetected (F2).
6. Cold attach with kept epochs → 6× the bytes (F5).
7. Mobile task numbering and its prerequisites against `mobile-app.md` and
   `TODO.md` → premise 13.

### What holds

- (A) is worth building. The per-save read-back is O(n) per round, it runs on
  the pod link, and since `local-runtime.ts:445` it runs every round. Reference
  identity is an exact detector for the replacements that exist (all of them
  REPLACE an element, including `closeFailedTurn`).
- B-plain JSONL: no (both rounds agree).
- The (C) analysis (strictness exists because the format is rewritten) is
  right. Its conclusion "only inside a log" is too strong: pre-public with one
  build, a typed optional field refused by an older build is today's normal
  rule, and it costs S when a reader exists.
- The pre-compaction transcript really is lost today
  (`session-store.ts:408-417`; the replacement path). That is the log's one
  genuine gain. An archive gets it without a log: at an epoch change, the
  laptop appends the projection it already holds to `<uid>.archive.jsonl`
  before overwriting. One limit: in a pod run with a mid-turn `context_reset`,
  rounds after the laptop's last read are not in that projection. That gap is
  at most one round, since the laptop saves at every `tool_result`.

### How the round-2 author behaved

Good: scripts pasted, numbers honest and reproducible, limits stated (k8s
estimate, Linux). Drift: round 2 fell for the owner's elegance prompt. Every
"objection resolved" in its table was checked against the cheapest correlate
(lines intact, count + last hash, replace + append), not against the property
the objection was about. And "each objection falls" overstated what a 4-writer
`writeSync` test shows.

### Verdict per option (this review)

| Option | Verdict |
|---|---|
| **A-plain** (`base {epoch, rev}` → `{from, messages}`, full-read fallback) | **BUILD now**, `feat/snapshot-incremental`, M · load-bearing. Round 1's sketch, plus: `closeFailedTurn` covered in the failure-mode tests; derivation reset at `historyReplaced`; acceptance = an end-to-end pod measurement (2 MB session: `readBack` time + the delay of a streamed chunk during it) |
| **A-as-log** | **NOT NOW**: only as part of a decided B-event-log, and then with F1–F5 designed in (firm L) |
| **B-plain JSONL** | **NO** |
| **B-event-log** (laptop, serve) | **DEFER** behind triggers: a reader that needs events (a viewer for the pre-compaction transcript beyond the archive, usage/cost reports, fork), records routinely > 10 MB, or a measured Linux `serve` fsync cost. If built: lineage chain (F1), whole-projection checkpoint (F2), removal + a reset-driven diff (F3), the laptop re-serializes validated known entries only (F4), cold start at the last compaction (F5), lazy JSON→log conversion (F6) |
| **C** | **When a reader exists**, as typed optional fields in today's records (S). No §7 wording change now |

### Owner questions, corrected (all at once; each with a recommendation)

1. **Build A-plain now (`feat/snapshot-incremental`, M · load-bearing)
   instead of A-as-log (L)?** — Yes: the same measured win, a smaller blast,
   and the extra cost later is conditional and small (F7).
2. **Make an end-to-end pod measurement A's acceptance check** (2 MB session:
   `readBack` time + the delay of a chunk streamed during it)? — Yes. M2 is the
   one user-visible number, and it is estimated.
3. **Defer the event log on the laptop AND on `serve`, with the triggers
   above recorded in `TODO.md`?** — Yes.
4. **Keep the pre-compaction transcript now, via an S task (the laptop appends
   the superseded projection to `<uid>.archive.jsonl` at each epoch change, no
   automatic pruning)?** — Yes if you value it. It is the log's only real gain,
   at about a tenth of the cost.
5. **(C): add typed optional fields (settings, usage totals) to today's
   records only when a reader needs them?** — Yes, defer.
6. **Mobile: record in `docs/eval/mobile-app.md` that the phone caches the
   projection and catches up with A's `{epoch, rev}` primitive (no event
   log)?** — Yes (F8).
7. **If the log is ever built, are F1–F5 binding requirements (lineage
   chain = `parentId`, whole-projection checkpoint, removal entry +
   reset-driven diff, laptop keeps only validated known entries from a pod,
   cold read from the last compaction)?** — Yes. Without them the log is less
   safe than today's JSON.
8. **The 173 existing JSON records, if the log is built: convert lazily
   (read `.json` when no `.jsonl`, write the log at the next save) or drop?**
   — Convert lazily: lossless, S.
9. **Leave the §7 sentence "Persist only `ChatMessage`s" unchanged until a
   log or typed facts actually land?** — Yes: no rule change without the code
   it governs.
10. **Linux fsync / `O_APPEND` measurements: only if (B) is revisited?** —
    Yes. They cannot change (A).

## Owner decisions (2026-11-07)

*— recorded by the orchestrator (claude-opus-5-5), 2026-11-07*

After round 1, round 2 and the fresh-context review, the owner decided:

1. **A-as-log, now.** The laptop↔daemon read-back becomes the typed event log (`session/log {after}`), not A-plain. The fresh review's **F1–F5 are binding requirements** of that task: lineage chain (`parentId` / previous-entry hash + daemon incarnation id; a fork is detected and set aside, never spliced), a whole-projection checkpoint (or the chain), a removal entry + a derivation reset at `historyReplaced`, the laptop keeps only KNOWN validated re-serialized entries from a pod (unknown pod entries dropped), and a cold read that starts at the last compaction. Acceptance includes the end-to-end pod measurement (2 MB session: read-back time + delay of a chunk streamed during it).
2. **The log on disk too — one format everywhere.** After task 1, the laptop store becomes the log (`<uid>.jsonl`, task 2), then the `serve` daemon store (task 3). Existing JSON records are converted lazily (read `.json` when no `.jsonl`, write the log at the next save). Linux fsync / `O_APPEND` measurements run before task 3.
3. **Keeping superseded history:** keep the pre-compaction AND pre-`context_reset` transcript (evaluate `/clear` too) in the log, behind a config key, **default `false`** (default behaviour = today's: superseded entries not kept).
4. **`type` on every entry from day one** (the discriminator key only). Settings, usage/cost, sub-agent runs, permission decisions: added as new types only when a reader needs them.
5. Orchestrator defaults (owner may object): the §7 persistence wording changes on the branch that lands the disk log (task 2); `docs/eval/mobile-app.md` records that mobile task 12 builds its cache and catch-up on `session/log {after}`.

Task order (one code task at a time): `feat/session-log` (wire, L · load-bearing) → `feat/session-log-laptop-store` (M · load-bearing) → `feat/session-log-serve-store` (M–L · load-bearing).
