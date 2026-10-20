# fix/session-store-durability — make session persistence crash-safe and its failures visible

> **Status:** done — merged to `main` 2026-10-20 (promoted from `eval/` 2026-10-20; post-review fixes applied, re-review waived by the owner)
> **Branch:** `fix/session-store-durability`
> **Type:** fix · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes (touches the §7 "persistence lives on the laptop/main thread" invariant and the persisted format's read path); mandatory fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is the on-disk session store
(`JsonSessionStore`) crash-safe, and do its failures surface to the user? If not,
do we promote a `fix` to make `save` atomic + serialized + error-surfacing and
`load`/`list` validating + loud?

### Code under examination

- `packages/agent/src/session-store.ts:63-66` — `save` = `mkdir` then
  `Bun.write(<uid>.json, …)` **in place**; no temp file, no rename, no fsync.
- `packages/agent/src/session-store.ts:69-79` — `load` wraps everything in
  `try { … (await f.json()) as SessionRecord } catch { return null }`: a parse
  error is indistinguishable from "absent", and there is no shape validation.
- `packages/agent/src/session-store.ts:82-105` — `list()` reads + fully parses
  every `*.json` sequentially, holds all records, sorts by `updatedAt`;
  `latest()` = `list()[0]`. Comparator `b.updatedAt - a.updatedAt` yields `NaN`
  for a record without `updatedAt`.
- Callers of `save` — both fire-and-forget, no `.catch`:
  - worker/pod path: `packages/cli/src/local-runtime.ts:117-124`
    (`void deps.store.save(...)` inside `persistingController`'s `persist`
    callback; `flush` at `:69-74` runs after every `send` (`:79-81`, in
    `finally`) and every `compact` (`:83-87`)).
  - in-process fallback: `packages/cli/src/main.ts:511-518`
    (`onPersist: (snapshot) => void store.save(...)`), fired by
    `Session.persist()` at `packages/agent/src/session.ts:74` (turn `finally`)
    and `:97` (after compact). Same issues as the worker path.
- Callers of `load`/`latest`: only the `--resume` paths,
  `packages/cli/src/main.ts:270` (pod) and `:452` (TUI). Not the plain startup
  path.
- No `unhandledRejection` handler anywhere in `packages/` (`rg unhandledRejection
  packages` → no hits).
- Overlap opportunity: `/compact` refuses only while a turn is running
  (`packages/tui/src/App.tsx:415`), but the compaction itself is
  `void session.compact()` (`:420`) and does not set `running`, so a new prompt
  (or an auto-wake turn) can start while the summarise call is in flight; both
  end with a `flush` → two un-serialized `save`s of the same file.

### Repros (throwaway scripts in the session scratchpad, importing the real `session-store.ts` by absolute path; Bun 1.4.3, macOS arm64)

**(a) Corrupt / wrong-shape file → silent disappearance, or a bogus resume.**
Store with `old` (updatedAt 1000) and `newest` (3000), then `newest.json`
truncated to half, plus a valid-JSON `{hello:"world"}` file:
```
load(newest) = null
latest().id = old              ← newest session silently gone from --resume
list ids = [ "old", undefined ] ← wrong-shape file accepted as a record
schema load = { hello: "world" }
```
Variant: `good` (updatedAt 5000) + `zzz.json` = `{"id":"zzz"}`:
```
latest = {"id":"zzz"} messages: undefined   ← NaN comparator lets it win
```
(With the file named `aaa.json` instead, `good` wins — order depends on
`readdir` order, i.e. undefined behaviour.) `--resume` would then print
`[resume] zzz — undefined` and seed the session with `messages: undefined`.

**(b) Unwritable store → the process dies.** `void s.save(rec)` (the exact call
shape of `local-runtime.ts:118` / `main.ts:512`) against a `chmod 555` dir:
```
EACCES: permission denied, open '…/ro2/x.json'
      at save (…/packages/agent/src/session-store.ts:65:15)
exit=1        ← "still alive after 200ms" never printed
```
(Same with a missing parent → `EACCES … mkdir` at `:64`.) Bun's default for an
unhandled rejection is to terminate the process, so in the TUI a disk-full /
EACCES on save does not silently drop the write — it **kills the session
mid-run and writes a raw stack to the terminal while Ink owns it** (violates the
§7 "never write raw to the terminal" invariant as a side effect).

**(c) `process.exit` vs a pending save.** `void save(); <wait>; process.exit(0)`:
```
delay=sync-microtask n=1   -> nofile
delay=sync-microtask n=600 -> nofile
delay=0ms  n=600 -> 634808 (complete)   delay=1ms / 5ms -> complete
```
An exit in the same tick loses the write entirely (the `mkdir` await alone is
enough), but one macrotask suffices for a 600 KB file. The real exit paths
(`/exit`, Ctrl+C when idle → Ink `exit()` → unmount → `runtime.dispose()` →
`main` returns → `process.exit`, `main.ts:569`) go through several awaits after
the turn's `flush` has already called `save`, so a drop there was **not
reproduced**. Exiting while a `/compact` is still summarising simply never
saves the compacted history (the previous file stays intact — benign).

**(d) Crash mid-write → truncated file.** A loop re-saving a ~42 MB record,
SIGKILLed at a random 1.0–1.9 s, 8 runs:
```
run 1..3,5..7 size=42389020 ok
run 4         size= 9437184 CORRUPT
run 8         size= 9437184 CORRUPT
```
2/8 kills left a truncated, unparseable file where a valid one existed before —
which (a) then silently hides. Real sessions are smaller (largest in the user's
dir: ~590 KB, 40 files / 4 MB total, read-only `ls`/`du`), so the window is ms
wide; the trigger is SIGKILL / OOM / power loss / laptop sleep-kill during a
save, not Ctrl+C (which is handled and exits cleanly).

**(e) Overlapping saves.** `Promise.all([save(older 20k msgs), save(newer 10
msgs)])`, 5 runs: 4× the newer won, **1× `final CORRUPT, size 10678`** — two
in-place writers to one path can interleave into garbage, not just "older wins".

**(f) `list()` cost.** Synthetic stores:
```
N=40   x 100 KB: latest() 3 ms,   rss 21 MB
N=200  x 600 KB: latest() 41 ms,  rss 149 MB
N=1000 x 600 KB: latest() 190 ms, rss 672 MB (1.3 GB on a 2nd call)
```
Linear in total history and holds every record in memory, but only on
`--resume` (no uid). At today's 40 files it is ~ms.

### Verdict per sub-claim

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | In-place `Bun.write` → crash mid-write truncates JSON | **CONFIRMED** | (d): 2/8 SIGKILLs → 9.4 MB truncated file |
| 2a | `void save` → rejected save is an unhandled rejection | **CONFIRMED — worse than claimed** | (b): not silent, the process **exits 1** with a raw stack |
| 2b | `/exit`/`process.exit` right after a turn drops/truncates the write | **PARTIALLY** | (c): only a same-tick exit loses it; real exit paths have enough ticks — not reproduced end-to-end |
| 2c | Overlapping saves not serialized; older snapshot can win | **CONFIRMED (mechanism) / narrow trigger** | (e): concurrent saves corrupt 1/5; app trigger = prompt or auto-wake during `/compact` (`App.tsx:415-420`), both flushes must land within ms |
| 3a | `load` swallows parse errors → session vanishes from `--resume`, no warning | **CONFIRMED** | (a): `latest()` silently falls back to `old` |
| 3b | No schema validation (`as SessionRecord`) | **CONFIRMED** | (a): `{id:"zzz"}` accepted and can become `latest()` via NaN sort |
| 4 | `list()` is O(total history) | **CONFIRMED, low impact** | (f); only `--resume` (`main.ts:270,452`), not normal startup |
| 5 | In-process fallback has the same issues | **CONFIRMED** | `main.ts:511-518` is the same `void store.save(...)` shape over the same store |

**Severity:** medium overall. Data loss requires an abnormal termination (or a
narrow overlap) — but when it happens it is *silent* (the newest session just
isn't offered by `--resume`), which is the failure mode AGENTS §8 calls a bug.
The unhandled-rejection crash (2a) is the most user-visible: rare trigger
(EACCES / ENOSPC / read-only `configDir`), but it tears down a live TUI.

### Eval verdict (the promotion decision)

*— claude-opus-5-5, 2026-10-17*

**Verdict: promote to `fix/session-store-durability`.** The core claims hold
under execution (1, 2a, 2c-mechanism, 3a, 3b, 5); 2b is overstated (realistic
exit paths have enough ticks) and 4 is real but cheap at current scale. Nothing
here needs a protocol change; it is confined to `session-store.ts` + the two
`void store.save` call sites, but it is the persisted-format read path behind
`--resume`, hence `load-bearing` and a strong-model task.

**Fix direction (in priority order):**
1. **Atomic write** in `save`: write `<uid>.json.tmp-<pid>-<rand>` in the same
   dir, (optionally `fsync`), then `rename` over `<uid>.json`. Rename within a
   dir is atomic on POSIX → a reader/crash sees old-or-new, never half. Clean up
   stray `*.tmp-*` on `list()`.
2. **Serialized save queue** per store (or per uid): chain each save on the
   previous promise, coalescing to "latest snapshot wins" so a burst writes once
   and the newest snapshot is always the last write. Kills (e) independent of
   the rename.
3. **Surface errors instead of `void`:** the callers attach a `.catch` that
   routes to a TUI notice / the `StatusLine` (never a raw `stderr` write while
   Ink owns the terminal — §7), so a disk-full save warns and the session keeps
   running. Expose a `flush()`/`drain()` on the store and await it in the
   teardown (`runtime.dispose` / before `process.exit`) — closes 2b for good.
4. **Loud, validated load:** distinguish *absent* (null) from *corrupt*
   (`{ error }` or a typed throw); validate the minimal shape (`id`, numeric
   `updatedAt`, `messages` array) — a hand-rolled check or the existing
   protocol schemas, no new dep. `list()` skips-and-reports bad files;
   `--resume` prints `[resume] skipped N unreadable session(s): …` (pre-mount, so
   writing is allowed) and, for an explicit uid, says "corrupt" not "no session".
   Optionally keep one `<uid>.json.bak` (previous good version) on save so a
   corrupt file is recoverable.
5. **(optional, defer)** metadata index (`index.json` of
   `{id,title,updatedAt,cwd}`) or a cheap header read so `latest()` doesn't
   parse every history. Not worth it at 40 files / 4 MB; revisit if `--resume`
   gets a picker or the store grows past ~hundreds of MB.

**Tests a fix must ship (red first, §9):** truncated file → `list()` reports it
and `latest()` doesn't silently pick an older one without a warning;
wrong-shape file → rejected; concurrent `save` × 2 → file parses and holds the
last-submitted snapshot (loop N times; currently ~1/5 corrupts); save against an
unwritable dir → caller's error sink invoked, no unhandled rejection
(`process.on("unhandledRejection")` spy); crash simulation → a pre-existing
`<uid>.json` is still valid when the write is interrupted (inject a write fn
that throws midway into the temp file).

**Reviewer notes on the claim:** the claim as filed was accurate on the
mechanisms but mis-characterised 2a as "silent" (it is a crash) and over-stated
2b. One additional finding not in the claim: the `NaN` sort comparator lets a
schema-less file become `latest()`. Unverified: whether a real `/compact` +
prompt overlap ever lands both saves within the same few ms in practice — verify
by instrumenting `save` with timestamps during a manual compact-then-prompt.

### Re-verified on `main` at promotion (2026-10-20)

*— claude-opus-5-5, 2026-10-20*

Several feats merged since the eval (`session-registry`, `session-ttl-limits`,
`daemon-compact-turn-guard`, …). Current line numbers and what changed:

- `packages/agent/src/session-store.ts:63-66` (`save`), `:69-79` (`load`),
  `:82-105` (`list`), `:108-110` (`latest`) — unchanged.
- Worker + pod path: `packages/cli/src/local-runtime.ts:141-148`
  (`void deps.store.save(...)` in the `persistingController` callback);
  `flush` `:76-81` runs in `send`'s `finally` (`:84-89`) and after `compact`
  (`:90-94`). Both pod runtimes go through `createLocalRuntime`
  (`pod-runtime.ts:276`, `:462`).
- In-process path moved: `packages/cli/src/main.ts:519-526`
  (`persist: (snapshot, createdAt) => void store.save(...)`), wired through
  `inProcessSessions` (`packages/cli/src/session-jobs.ts:85-88`, `:117`) into
  `Session.persist()` (`packages/agent/src/session.ts:50-52`, called at `:74`
  turn `finally` and `:105` after compact).
- Resume readers: `main.ts:275-293` (`loadPodResume`, `run`/`attach`) and
  `main.ts:460-473` (TUI) — two copies of the same logic.
- Overlap trigger (2c) **narrowed**: since `fix/daemon-compact-turn-guard` the
  daemon holds one busy slot (`packages/daemon/src/hosted-session.ts:394-402`),
  so a prompt during `/compact` is rejected on the worker/pod path. But the
  rejected `send` still runs `persistingController`'s `finally` flush while the
  compact's own flush is pending, and the **in-process** `Session` has no guard
  at all (`session.ts:91-106`; `App.tsx:415-422` fires `void session.compact()`
  without setting `running`). Concurrent `save`s of one uid remain reachable.
- `rg unhandledRejection packages` → only a test spy
  (`packages/client/test/remote.test.ts:1344`); no handler in app code.

**Repro** (`.tentacle/tmp/session-store-durability/repro.ts`, Bun 1.4.3,
macOS arm64, 2026-10-20; imports `@tentacle/agent`):

```ts
// repro.ts — session store durability, run on current main.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord } from "@tentacle/agent";

const base = await mkdtemp(join(import.meta.dir, "run-"));
const rec = (id: string, updatedAt: number, n = 2): SessionRecord => ({
  id, cwd: "/w", model: "m", createdAt: 1, updatedAt, title: id,
  messages: Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `m${i} ${"x".repeat(50)}` })),
});
// (a) corrupt + wrong-shape files
{
  const s = new JsonSessionStore(join(base, "a"));
  await s.save(rec("old", 1000));
  await s.save(rec("newest", 3000));
  const p = join(base, "a", "newest.json");
  const txt = await readFile(p, "utf8");
  await writeFile(p, txt.slice(0, txt.length / 2));
  await writeFile(join(base, "a", "zzz.json"), JSON.stringify({ id: "zzz" }));
  console.log("(a) load(newest) =", await s.load("newest"));
  console.log("(a) list ids =", (await s.list()).map((r) => r.id));
  const l = await s.latest();
  console.log("(a) latest =", l?.id, "messages:", l?.messages === undefined ? "undefined" : l.messages.length);
}
// (e) overlapping saves of one uid
{
  const s = new JsonSessionStore(join(base, "e"));
  let corrupt = 0, olderWon = 0;
  for (let i = 0; i < 20; i++) {
    await Promise.all([s.save(rec("u", 1, 20000)), s.save(rec("u", 2, 10))]);
    try {
      const r = JSON.parse(await readFile(join(base, "e", "u.json"), "utf8"));
      if (r.updatedAt !== 2) olderWon++;
    } catch { corrupt++; }
  }
  console.log(`(e) 20 overlapping save pairs: corrupt=${corrupt} olderWon=${olderWon}`);
}
// (d) SIGKILL during a save loop of a large record (child: load "big", then `for (;;) await s.save(r)`)
//     6 runs, kill at 0.8–1.5 s, then JSON.parse the file.
await rm(base, { recursive: true, force: true });
```

Output:

```
(a) load(newest) = null
(a) list ids = [ "zzz", "old" ]
(a) latest = zzz messages: undefined
(e) 20 overlapping save pairs: corrupt=6 olderWon=8
(d) 6 SIGKILLs mid-save-loop: corrupt=1
```

(a) is now *worse* than in the eval: the schema-less `{id:"zzz"}` file wins
`latest()` (NaN comparator, readdir order) — `--resume` would seed
`messages: undefined`. (e) also shows **older wins 8/20**, not just corruption.

**(b) unhandled rejection — the exact shape matters.** `voidsave2.ts` mimics
the TUI (event-loop driven, no top-level await):

```ts
import { JsonSessionStore } from "@tentacle/agent";
const s = new JsonSessionStore(`${import.meta.dir}/ro`);   // chmod 555
let n = 0;
const t = setInterval(() => {
  n++;
  if (n === 1) void s.save({ id: "x", cwd: "", model: "", createdAt: 0, updatedAt: 0, title: "", messages: [] });
  console.log("tick", n);
  if (n === 5) { clearInterval(t); console.log("survived"); }
}, 100);
```
```
tick 1
EACCES: permission denied, open '…/ro/x.json'
    code: "EACCES"
exit=1                     ← ticks 2..5 never run: the process dies at once
```
(With a pending **top-level** `await Bun.sleep(200)` instead, Bun prints the
error, lets the module finish, then exits 1 — a Bun quirk; the TUI is the
interval shape.) Confirms 2a: a failed save kills a live TUI.

## Implementation

*— claude-opus-5-5, 2026-10-20*

Scope = the eval's fix directions 1–4. Direction 5 (metadata index) is
deferred (Notes). `.bak` copies are dropped: with atomic writes the only
remaining corruption sources are external edits / disk faults, and those are
now *reported* instead of hidden.

### Load-bearing assumption

**`rename(2)` of a fully written temp file onto `<uid>.json` in the same
directory is atomic**: any reader, or a crash at any instant, sees either the
complete old file or the complete new one — never a mix. Everything else
(serialization, validation, reporting) is ordinary code on top. Proof is
empirical (§2), not from the docs: the regression test for "interrupted write
leaves the previous file intact" plus a re-run of repro (d) (SIGKILL in a save
loop) against the new store, which must give `corrupt=0` over the same runs
that gave `corrupt=1` on `main`. Same-directory placement of the temp file is
what makes it a rename and not a cross-device copy.

### Preconditions

- P1. The store is the only writer of `<configDir>/sessions/*.json`, and every
  save goes through `JsonSessionStore.save` (`session-store.ts:63-66`); call
  sites are exactly `local-runtime.ts:141-148` and `main.ts:519-526` (`rg
  "store\.save" packages/*/src`). Reads: `main.ts:281` and `:463` only.
- P2. §7 *persistence lives on the laptop/main thread*: both call sites run on
  the main thread; the fix keeps that (no daemon-side write is added).
- P3. §7 *never write raw to the terminal while Ink owns it*: the save callbacks
  fire while Ink is mounted, so their errors must go to an in-TUI notice; only
  pre-mount (`[resume] …`) and post-unmount (final drain) may `write`.
- P4. The TUI already renders out-of-band notices from a subscription while idle
  (`App.tsx:196-220`, `jobs.onExit` → state append → `flushNow`), and
  `pushNotice` (`App.tsx:319-327`) is the existing notice renderer. A new
  `notices` prop follows that exact pattern.
- P5. Records are seeded back via `session/open`, whose `messages` are
  `z.array(ChatMessageSchema)` with `.strict()` messages
  (`packages/protocol/src/session.ts:28-35`, `:244`). A record whose messages
  fail that schema would fail at open with a protocol error — so the load-side
  check must be at least as strict as the wire schema for messages.
- P6. `daemon-side-persistence` (the next child, `docs/eval/daemon-side-persistence.md:392-399`)
  assumes this fix gives: atomic save; serialized latest-wins per uid; save
  *rejects* (doesn't crash); `load` distinguishes corrupt from absent; `list`
  skips-and-reports; **extra record fields preserved verbatim**; a `drain()`.
  The API below is shaped to satisfy exactly that.
- P7. Pre-public: changing `load/list/latest` return types is allowed
  (AGENTS §7 protocol rule spirit; memory "pre-public: breaking OK"). The
  on-disk format itself does not change (same JSON, same path) — old files
  stay readable.

### Design

**Store (`packages/agent/src/session-store.ts`) — durable and honest.**

1. *Atomic write.* `save` serializes the record, writes it to
   `<dir>/.<uid>.json.tmp-<pid>-<rand8>` through an injectable
   `writeDurable(path, data)` (default: `open(path, "w", 0o600)` →
   `writeFile` → `sync()` (fsync) → `close`), then `rename`s it onto
   `<uid>.json`. On any failure the temp is removed (best-effort) and the error
   is re-thrown as `couldn't write <dir>/<uid>.json: <reason> (<CODE>)` — the
   file the user knows, never the hidden temp it failed on (revised
   post-review, finding 5). Files become mode `0600` (session history is private; with a
   rename every save is a new inode anyway, so a user's chmod would not survive
   regardless). Directory fsync is not done (Notes).
2. *Serialized, latest-wins per uid.* A per-uid slot: if no write is running,
   start one; if one is running, the new record **replaces** any queued one and
   the caller shares the queued write's outcome. So a burst of N saves does ≤ 2
   writes, the last *submitted* snapshot is always the last written, and two
   writers never touch the file at once. `save` resolves when a write
   containing this record **or a newer one** is durable; it **rejects** if that
   write failed. Contract (doc comment): a caller must handle the rejection.
3. *`drain(): Promise<void>`* resolves once every slot is idle (loops until no
   write is running, since a settle can start the queued one).
4. *Validated, loud reads.* A pure exported `parseSessionRecord(value, id)` →
   `{ ok: true, record } | { ok: false, reason }` checks: plain object; `id`
   string equal to the file stem; `cwd`, `model`, `title` strings;
   `createdAt`, `updatedAt` finite numbers; `messages` an array whose items
   mirror the strict wire `ChatMessageSchema` (role ∈
   system|user|assistant|tool, `content` string, optional `toolCalls` array of
   `{id,name,arguments}` strings, optional `toolCallId` string, **no other
   keys**). Extra *record* keys are allowed and preserved verbatim (P6).
   Hand-rolled (agent has no runtime zod dep and must not depend on
   protocol); a cli test pins the mirror against the real schema.
   - `load(id)` → `{ status: "ok", record } | { status: "absent" } |
     { status: "unreadable", reason, file }`. An `id` that is not a safe file
     stem (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`) → `unreadable` ("invalid session
     id") — `--resume ../x` must not read outside the dir. Read errors (EACCES,
     EISDIR) and JSON parse errors are `unreadable` with the message.
   - `list()` → `{ records, skipped: { id, file, reason }[] }`, newest
     `updatedAt` first, ties by `id` (deterministic — validation guarantees no
     NaN). Ignores non-`*.json` names (so temps are never read).
   - *Crash-leftover sweep* (revised post-review, finding 4): before a store's
     **first write**, and on every `list()`, best-effort remove
     `.<uid>.json.tmp-<pid>-<rand>` files whose writer pid is **dead**
     (`process.kill(pid, 0)` → ESRCH), or that are older than 1 h (pid reuse).
     A live writer's temp (another tentacle mid-save, or this process) is kept.
   - `latest()` → `{ record: SessionRecord | null, skipped }`.

**Reporting (cli) — failures reach the user, never the raw terminal.**

5. `packages/cli/src/notice-hub.ts` — `NoticeHub implements NoticeFeed`
   (`NoticeFeed` is a new tui type: `onNotice(listener): () => void`).
   `notify(text)` delivers to listeners, or **buffers** while there are none
   (so pre-mount notices, e.g. resume warnings, show once the TUI subscribes).
6. `packages/cli/src/session-saver.ts` — `SessionSaver(store, notify)`:
   - `save(record): void` — calls `store.save(record).then(ok, fail)`; never
     throws, never leaves a rejection unhandled.
   - per-uid state machine (pure, exported `nextSaveState`): ok→failed emits
     ONE notice ``⚠ Session <id8> not saved — <message>. The conversation
     continues; tentacle retries after the next turn.``; failed→failed is
     silent (no spam every turn; the error is updated); failed→ok emits
     ``Session <id8> saved again.``.
   - `drain(options?): Promise<string[]>` — waits for its **own** pending
     outcome handlers (it depends only on `save`'s promise: the saver takes a
     `Pick<JsonSessionStore, "save">`), **bounded** (revised post-review,
     finding 3): `onSlow(ids)` once after 1 s, give up after 10 s. Returns one
     post-unmount line per uid not safely on disk: still writing at the
     deadline (``[session] gave up waiting for session <uid> after 10s — …``)
     or **last** write failed (``[session] not saved: <uid> — <message> (any
     file on disk is from an earlier save)``).
7. Wiring: `LocalRuntimeDeps.store` → `saver: SessionSaver` (it only ever
   saved); same rename on `startWorkerRuntime`, `PodRuntimeDeps`,
   `AttachRuntimeDeps` (pass-through). In-process: `persist: (…) =>
   saver.save(...)`. `TuiOptions`/`AppProps` gain `notices?: NoticeFeed`; App
   subscribes like `jobs.onExit` and appends a `notice` item (pure
   `appendNotice`). Every TUI path in `main.ts` (worker, in-process,
   `runPodTui`) goes through ONE tested function (revised post-review,
   findings 1–2), `packages/cli/src/tui-sessions.ts`:
   `openTuiSessions(dir, resume, write)` (store + hub + saver + `resolveResume`)
   and `runSessionTui(sessions, { start, teardown, write })`, which hands
   `start` the `{ notices, resumeMessages }` to spread into `startTui`, then
   `try { start } finally { try { teardown } finally { drain + write lines,
   printing "[session] still saving …" if slow } }` — the drain runs even if the
   TUI or the teardown throws, and only after Ink unmounted. Closes 2b.
9. *Quit mid-turn saves the turn* (added post-review, finding 8): a pure
   `quitAction(source, running, exitPending)` (`tui/src/commands.ts`). `/exit`
   or `/quit` during a turn → show "Stopping the turn so it is saved before
   exiting — /exit or Ctrl+C again to quit now", abort the turn, and `exit()`
   from the turn's `finally` (after the session's own persist ran). A second
   quit request while stopping quits at once (a turn that won't stop must not
   trap the user). Ctrl+C mid-turn still only stops the turn.

**Resume (cli) — one copy, loud.**

8. `packages/cli/src/session-resume.ts` — `resolveResume(store, uid?)` →
   `{ record, lines, notices, fatal }`, replacing both copies in `main.ts`:
   - uid given, `ok` → `[resume] <id> — <title>`.
   - uid given, `absent` → `[resume] no session "<uid>"; starting fresh` (as today).
   - uid given, `unreadable` → **fatal**: `[resume] session "<uid>" is
     unreadable: <reason> (<file>); not starting — fix or remove the file, or
     run without --resume`, exit 1. Starting fresh would hide it behind the
     alt-screen; the user asked for *that* session.
   - no uid → `latest()`; if `skipped` is non-empty, a line **and** an in-TUI
     notice ``⚠ Skipped N unreadable session file(s): <file> (<reason>), …``
     (the line alone would be hidden by the alt-screen until exit). Then the
     resumed line or `no saved sessions yet`.

### Files

In dependency order:

1. `packages/agent/src/session-store.ts` — items 1–4.
2. `packages/agent/test/session-store.test.ts` — store tests (below); adapt the
   existing `list`/`latest` assertions to the new shapes.
3. `packages/tui/src/App.tsx`, `packages/tui/src/run.tsx`,
   `packages/tui/src/index.ts` — `NoticeFeed` type + `notices` prop
   (subscription → `pushNotice`). `packages/tui/test/app.test.tsx` — one test.
4. `packages/cli/src/notice-hub.ts`, `packages/cli/src/session-saver.ts`,
   `packages/cli/src/session-resume.ts` (new).
5. `packages/cli/src/local-runtime.ts`, `packages/cli/src/pod-runtime.ts` —
   `store` → `saver` in deps, `saver.save(...)` at the call site.
6. `packages/cli/src/main.ts` — `resolveResume` at both resume sites; one
   `NoticeHub` + `SessionSaver` per TUI run; `notices` to `startTui`;
   drain + print after teardown in all three TUI paths.
7. Tests: `packages/cli/test/session-saver.test.ts`,
   `packages/cli/test/session-resume.test.ts`, `packages/cli/test/notice-hub.test.ts`
   (new); mechanical `store:` → `saver:` in `local-runtime.test.ts`,
   `pod-runtime.test.ts`, `worker.test.ts`, `fixtures/worker-exit-net.ts`.

8. *(post-review)* `packages/cli/src/tui-sessions.ts` + `packages/cli/test/tui-sessions.test.ts`
   (new); `packages/tui/src/commands.ts` (`quitAction`) + `commands.test.ts`;
   `App.tsx` quit handling + two `app.test.tsx` tests.

No protocol change, no `PROTOCOL_VERSION` bump, no on-disk format change
(files are now written mode `0600`).

### Failure modes

| # | Failure | Convergence |
|---|---|---|
| F1 | Crash / SIGKILL / power loss mid-write | Temp is partial, `<uid>.json` untouched (rename not reached) → next start reads the previous complete save. The stray temp (dead pid) is swept by the next process's first save or `list()`. Power loss before the data hits disk: fsync before rename → old-or-new. |
| F2 | EACCES / ENOSPC / EROFS on save | `save` rejects → saver catches → one in-TUI notice; session keeps running; every later turn retries with the newest snapshot; success → "saved again". Still failing at exit → post-unmount line. Never an unhandled rejection. |
| F3 | Two saves of one uid overlap (rejected prompt during compact; in-process compact + prompt) | Serialized per uid; last submitted wins; never interleaved. |
| F4 | Saves of different uids (old session after `/clear` + new one) | Independent slots; both written; failure state tracked per uid (a success on B never reports A as "saved again"). |
| F5 | Exit right after a turn (`/exit`, idle Ctrl+C) | `drain()` after teardown awaits every in-flight/queued write before `main` returns → `process.exit`. |
| F6 | SIGINT/SIGTERM mid-turn (no graceful teardown) | Not changed: the process dies; F1 guarantees the file is the last complete save. |
| F7 | Truncated / non-JSON / wrong-shape / id≠stem file | `unreadable` with a reason. `--resume <uid>` → fatal exit 1 naming the file. `--resume` → skipped, reported (line + notice), never wins `latest()`. File is never overwritten (a resume of another uid can't target it; a fresh session gets a new uid). |
| F8 | Extra record fields (future `DaemonSessionRecord`) | Accepted and preserved verbatim through load → save. |
| F9 | Unsafe `--resume` uid (`../x`, empty) | `unreadable` "invalid session id" → fatal, no read outside the dir. |
| F10 | Two tentacle processes on the same uid | Not serialized across processes (no lock), but each write is atomic → last rename wins, file always valid. Per-process temp names (pid+rand) never collide. Accepted (same as today minus corruption). |
| F11 | Directory missing | `save` creates it (as today); `list`/`latest` → empty, no skipped. |
| F12 | Notice emitted before the TUI subscribes / after unmount | Hub buffers until the first listener; after unmount the drain lines cover save failures. |
| F13 | `stat`/`unlink` of a stale temp fails | Ignored (best-effort cleanup never fails a `list()` or a save). |
| F14 | `/exit` while a turn is running (pre-existing; review finding 8) | The turn is aborted and the App exits from the turn's `finally`, after the session persisted it → the drain writes it. A turn that ignores the abort: a second `/exit`/Ctrl+C quits at once (that turn is then not saved — the user chose it, and was told). |
| F15 | Hung filesystem at exit (stalled NFS/FUSE) | After 1 s `[session] still saving <uid>…`; after 10 s the drain gives up and reports the uid as not saved; exit proceeds. |
| F16 | `runtime.dispose()` / `mcp.dispose()` or the TUI throws | The drain is in a nested `finally`: saves are still awaited and reported, then the error propagates as before. |

### Tests

Red-before-green on the buggy store where the property exists today; the new
modules are red by construction and get mutation checks instead (§9).

Store (`session-store.test.ts`):
- T1 *truncated newest file is reported, not silently skipped*: `latest()`
  returns the older one **and** `skipped` names `newest.json`; `load("newest")`
  is `unreadable` (red today: `load` → `null`, `latest()` has no `skipped`).
- T2 *schema-less file never wins*: `good` + `{"id":"zzz"}` → `latest().record.id
  === "good"`, `zzz` skipped with a reason (red today: zzz wins, per repro).
- T3 *concurrent saves*: 30× `Promise.all([save(big older), save(small newer)])`
  → file parses and `updatedAt` is the newer every time (red today: 6/20
  corrupt, 8/20 older-wins).
- T4 *interrupted write keeps the previous file*: injected `writeDurable`
  writes half the data then throws → `save` rejects, `<uid>.json` still the
  previous record, no temp left in the dir (red today: in-place write
  succeeds → the assertion on the previous record fails).
- T5 *coalescing*: gated `writeDurable`: save A (blocks), B, C → after
  release, exactly 2 writes (A, C), file = C, B's promise resolves with C's
  write. Plus: a failing gated write rejects every caller sharing it.
- T6 extra record field round-trips; T7 unsafe id → unreadable; T8 stale temp
  (mtime − 2 h) removed by `list()`, fresh temp kept; T9 `drain()` resolves only
  after a gated write is released; T10 non-message keys / bad role rejected.

cli:
- `session-saver.test.ts`: failing injected store → exactly one notice over two
  failures, then "saved again" on success, per-uid isolation, `drain()` lines
  only for uids whose last write failed; a `process.on("unhandledRejection")`
  spy sees nothing across all of it.
- `notice-hub.test.ts`: buffered-until-subscribe, then live, unsubscribe.
- `session-resume.test.ts`: the four branches of `resolveResume`; the mirror
  test (`parseSessionRecord` accepts exactly what `ChatMessageSchema` accepts on
  a table of messages, incl. an extra key → both reject).
- `local-runtime.test.ts`: after a turn, `await saver.drain()` with **no
  sleep** → the file is there (pins that the *drain* waits for the turn's
  save; that every TUI path *calls* the drain is pinned by
  `tui-sessions.test.ts`, added post-review); existing tests adapted.

tui (`app.test.tsx`): a notice pushed on the `notices` feed appears in the frame
while idle.

Mutations to run (§9): drop the `rename` (write the target directly) → T4
red; drop the slot queue (write immediately) → T3/T5 red; `void store.save` in
the saver → unhandled-rejection spy red; make `parseSessionRecord` return ok
→ T1/T2 red; remove the saver drain from `local-runtime` test path → F5 test red.

### Notes / debt

- **Metadata index** (eval direction 5) deferred: `list()` still parses every
  file (~ms at today's 40 files / 4 MB; repro (f)). Revisit with a `--resume`
  picker or ≫100 MB of history.
- **No directory fsync** after the rename: on power loss the rename itself may
  be lost, leaving the *previous* complete file — still valid, just one save
  older. Acceptable; the store's guarantee is "never half a file".
- **No cross-process lock** (F10): two processes on one uid → last rename wins,
  always a valid file.
- **Wiring left in `main.ts`**: each TUI path must still *call*
  `runSessionTui` and spread `sessionOptions` into `startTui`; a `main()`-level
  test would need an injectable `startTui` — not worth it for three call sites
  whose shape is now one line each. Verified e2e instead (Execution).
- **No `.bak`**: atomic writes remove the in-process corruption source; what's
  left (external edits, disk faults) is now reported, not hidden.
- `docs/eval/session-store-per-project.md` cites the old `latest()` shape and
  line numbers; its design (a per-cwd `JsonSessionStore` dir) is unaffected —
  refresh its citations when it is promoted.

## Execution

*— claude-opus-5-5, 2026-10-20*

Approval: the owner's go-ahead at promotion ("promuoviamo … e lavoriamoci")
was taken as approval to run Implementation → Execution → one fresh-context
Review without an intermediate stop.

**As built, in order.**

1. `git switch -c fix/session-store-durability`; `git mv` the eval doc here.
   Re-ran the Context repro on `main` (output in *Re-verified on `main`*).
2. **Store tests first, shown RED on the unchanged store** (the `parseSessionRecord`
   test was held back for this run, since importing a missing export fails the
   whole file rather than an assertion):
   ```
   (fail) … a truncated newest file is reported, not silently replaced …   Expected: "unreadable"  Received: undefined
   (fail) … a schema-less file is skipped with a reason and never becomes latest()
   (fail) … overlapping saves of one uid never corrupt the file and the last submitted wins   Expected: 2  Received: 1
   (fail) … an interrupted write leaves the previous file intact and no temp behind   Expected promise that rejects / Received promise that resolved
   (fail) … a burst coalesces … / a failed shared write rejects … / drain() … / extra record fields … / an unsafe id … / list() removes stale temp files …
    6 pass  10 fail
   ```
   T1–T4 are red on the *property* (older wins, interrupted write succeeds in
   place, …); the rest are red by construction (new API).
3. `packages/agent/src/session-store.ts` — atomic temp+fsync+rename write
   (`writeAtomic`), per-uid `WriteSlot` queue with latest-wins coalescing
   (`save`/`pump`), `drain()`, `parseSessionRecord` + `isValidSessionId`
   (exported), `load` → `LoadResult`, `list` → `{records, skipped}` with
   stale-temp cleanup, `latest` → `{record, skipped}`. Existing store tests
   adapted to the new shapes. → 17/17 green.
4. TUI: `NoticeFeed` + `notices` prop (`App.tsx`, `run.tsx`, `index.ts`), a
   pure `appendNotice` in `state.ts`; `app.test.tsx` test (notice renders
   while idle; listener removed on unmount).
5. cli: `notice-hub.ts`, `session-saver.ts`, `session-resume.ts` (new);
   `local-runtime.ts` + `pod-runtime.ts` `store` → `saver`; `main.ts`:
   `openSessions` (hub + saver + `resolveResume`, replaces the two resume
   copies), `notices` passed to all three `startTui` calls, `finishSaves`
   after teardown in the worker, in-process and `runPodTui` paths.
   Mechanical `store:` → `saver:` in `local-runtime.test.ts`,
   `pod-runtime.test.ts`, `worker.test.ts`, `fixtures/worker-exit-net.ts`
   (`(await store.list()).records`, `(await store.latest()).record`).
6. New tests: `session-saver.test.ts` (4 + `nextSaveState`),
   `notice-hub.test.ts`, `session-resume.test.ts` (5 branches + 15-case
   mirror table against the real `ChatMessageSchema` + key tripwire),
   `local-runtime.test.ts` "save is on disk once the saver drains — no sleep".
7. End-to-end trace through the real CLI (`TENTACLE_CONFIG_DIR` = a scratch
   dir with a truncated `abc.json`):
   ```
   $ tentacle --resume abc
   [resume] session "abc" is unreadable: invalid JSON (JSON Parse error: Unterminated string) (…/cfg/sessions/abc.json); not starting — fix or remove the file, or run without --resume
   exit=1
   $ tentacle --resume ../etc          # before the fix in step 8
   [resume] session "../etc" is unreadable: invalid session id "../etc" (…/cfg/etc.json); not starting — fix or remove the file, …
   $ tentacle --resume ../etc          # after
   [resume] "../etc" is not a valid session id; not starting
   exit=1
   ```
8. The trace found a defect: for an invalid id the message showed a
   *normalized* path that doesn't exist and told the user to "fix the file".
   Fixed: `resolveResume` checks `isValidSessionId` first (fatal, no path);
   test added.
9. Repro re-run against the new store (`repro-after.ts`, same scenarios, new
   API; and `kill.ts`, (d) alone with 20 runs):
   ```
   (a) list ids = [ "old" ] skipped = [ "newest: invalid JSON (JSON Parse error: Unterminated string)", "zzz: \"cwd\" is not a string" ]
   (a) latest = old
   (e) 20 overlapping save pairs: corrupt=0 olderWon=0          (main: corrupt=6 olderWon=8)
   (d) 6 SIGKILLs mid-save-loop: corrupt=0                      (main: corrupt=1)
   20 SIGKILLs mid-save-loop: corrupt=0, stray temps left=5     (temps are removed by a list() after 1 h)
   ```
   (b) in that script still calls the raw `store.save` with `void` — by
   contract it rejects; the app never calls it that way any more (both call
   sites go through `SessionSaver`, `rg "store\.save" packages/*/src` → none
   outside the store).
10. Mutations (§9), each applied, the named test run, the file restored
    (`.bak` copy; `git diff --stat` unchanged afterwards):

    | Mutation | Test | Result |
    |---|---|---|
    | M1 write the target in place, no rename | interrupted write | RED |
    | M2 no per-uid queue (`save` → `writeAtomic` directly) | overlapping / coalesces / shares it / drain | RED (4) |
    | M3 saver `void this.store.save(record)` | reported once … unhandled rejection | RED |
    | M4 `parseSessionRecord` always ok | schema-less | RED |
    | M5 App ignores `notices` | host notice | RED |
    | M6 runtime drops `saver.save` | save on disk once the saver drains | RED (first attempt was a syntax error in the mutation itself — redone with a valid one) |
    | M7 temps removed regardless of age | stale temp | RED |
    | M8 hub doesn't buffer | buffers until the first subscriber | RED |

11. Gate: `bun run check` → typecheck clean, `biome check` clean (283
    files, 0 errors/warnings), **1006 pass, 2 skip (the opt-in live-k8s and
    slow keepalive), 0 fail** (1008 tests, 106 files).

**Drift from Implementation.**

- `SessionSaver.drain` waits on its *own* pending outcome handlers (a `Set`
  of the `.then` chains), not just `store.drain()`: the store settles a write
  before the saver's callback runs, so awaiting the store alone could report a
  stale state. An exact wait instead of a timing assumption. **(Rationale
  wrong — see Post-review fixes, 5b.)**
- `notify` failures inside `SessionSaver.settle` are caught (a throwing
  listener must not turn a handled save into an unhandled rejection) — not in
  the plan; tested.
- The App renders host notices as `{ kind: "notice" }` items through a new pure
  `appendNotice` (`state.ts`), not via `pushNotice` (P4): `pushNotice` appends
  an `assistant` item, the wrong kind for a system line that can arrive right
  as a turn ends. `state.ts` wasn't in the file list.
- `isValidSessionId` exported and checked first in `resolveResume` (step 8).
- Existing tests that wait with `setTimeout(20)` after a turn were left as
  they are (they still pass; only the new test pins "no sleep needed").

### Post-review fixes (owner: "correggi tutti e 6, senza ulteriore review")

*— claude-opus-5-5, 2026-10-20*

The owner asked for all six open points fixed and **waived a second
review**. So the fixes below were checked only by the executor's own tests,
mutations and e2e runs. No fresh-context pass has seen this round.

| Review finding | Fix | Where |
|---|---|---|
| 1 drain / resume notices unpinned in `main.ts` | Session plumbing extracted into `tui-sessions.ts` (`openTuiSessions`, `runSessionTui`), one call per TUI path; `startTui` gets `{notices, resumeMessages}` as one spread object | `packages/cli/src/tui-sessions.ts`, `main.ts` (`openSessions`, `runPodTui`, worker + in-process paths) |
| 2 throwing teardown skips the drain | Drain in a nested `finally` | `tui-sessions.ts` `runSessionTui` |
| 3 unbounded, silent exit drain | `drain({timeoutMs=10s, slowMs=1s, onSlow})`; "still saving …" line; "gave up waiting …" line | `session-saver.ts` `drain` |
| 4 crash temps pile up | pid-aware sweep before a store's first write and on `list()` (dead writer, or > 1 h) | `session-store.ts` `sweepTemps`, `processAlive` |
| 5a error names the hidden temp | `couldn't write <uid>.json: permission denied (EACCES)` | `session-store.ts` `writeAtomic`, `describeFsError` |
| 5b drain rationale not shown | The saver now takes `Pick<JsonSessionStore,"save">` and waits only on its own outcome handlers. A test with a store that has no `drain` and fails late pins this. My earlier claim ("awaiting the store alone could report a stale state") was **wrong**: microtask order makes it work today, as the reviewer showed (R7). The design was kept for decoupling, not for that reason. | `session-saver.ts`, `session-saver.test.ts` |
| 5c stale eval docs | Dated "Update 2026-10-20" notes. The original evidence is not rewritten. | `docs/eval/attachments.md`, `docs/eval/history-validity-invariant.md`, `docs/eval/daemon-side-persistence.md` (assumed-interfaces "as built") |
| 6 (#8) `/exit` mid-turn never saves the turn | Pure `quitAction`; the App stops the turn, then exits from its `finally`; a second quit request exits at once | `packages/tui/src/commands.ts`, `App.tsx` (`exitPendingRef`, `/exit` case, Ctrl+C, `run` `finally`) |

**Red first: item 6, by test.** On the unchanged App, the two new
`app.test.tsx` tests failed on the assertion:
```
- "turn settled (aborted)",        (the expected log)
+ [ "unmounted" ]                  ← unmounted; the turn never even settled
(fail) App > /exit mid-turn stops the turn and exits only after it settled (so it is saved)
(fail) App > a second /exit while the turn won't stop quits at once
```
**Items 1–5: red by mutation.** These tests were written after the code.
Each mutation below brings back the pre-fix behaviour (`.bak` copy, file
restored, `git diff | shasum` identical before and after):

| Mutation | Test | Result |
|---|---|---|
| N1 no sweep before the first write | crash leftovers are swept on the first save | RED |
| N2 rethrow the raw (temp-path) error | a failed save names `<uid>.json` | RED |
| N3 saver drain doesn't wait | drain waits for save's own outcome | RED |
| N4 drain unbounded | a hung save … never hangs | RED (3 s timeout) |
| N5 `onSlow` never called | a slow drain says it is waiting | RED |
| N6 drain not in the inner `finally` | a throwing teardown still drains | RED |
| N7 `runSessionTui` drops the drain lines | … teardown, then the drain … in order | RED |
| N8 resume warnings not sent to the TUI | … reaches the TUI | RED |
| N9 `/exit` always exits at once | both `/exit` App tests | RED |
| N10 `quitAction` command mid-turn → exit | quitAction | RED |
| N11 no `exit()` after the turn settles | /exit mid-turn … | RED |

The first-round set (M1–M6, M8) was re-run against the revised code and is
still RED. (M6's scripted form is a syntax error again; the valid form, run by
hand, is RED.) M7 was dropped because the age-only rule it mutated was
replaced; N1 covers the sweep.

**End-to-end, real CLI** (pty via `script`, `TENTACLE_CONFIG_DIR` set to a
scratch dir, OpenAI-compatible SSE mocks under
`.tentacle/tmp/session-store-durability/e2e/`):

- `/exit` during a turn the model never finishes, sent at ~2 s. Fix: the
  session file holds the turn, on both the worker and the in-process path.
  `main`'s `App.tsx` (swapped in temporarily, then restored byte-identical):
  **nothing saved**. The "/exit or Ctrl+C again to quit now" notice is on
  screen.
  ```
  == worker:     cb37f1ed-….json  [('system', …), ('user', 'hi')]
  == in-process: ac16f628-….json  [('system', …), ('user', 'hi')]
  == main App, worker: (no sessions dir — nothing saved)
  ```
- Read-only sessions dir. The notice shows in the TUI ("…continues; tentacle
  retries after the next turn."). After exit (byte 2157, after
  `ESC[?1049l` at 2149):
  `[session] not saved: 3a245511-… — couldn't write …/sessions/3a245511-….json: permission denied (EACCES) (any file on disk is from an earlier save)`.

**Gate:** `bun run check` → typecheck clean, `biome check` clean (285
files), **1020 pass, 2 skip (opt-in live-k8s and slow keepalive), 0 fail**
(1022 tests, 107 files).

**Review finding 9 (unverified there) is closed:** `load()` (read-only, never
`list()`) over the owner's real `~/.config/tentacle/sessions` gave 52 files,
52 `ok`.

**Not verified:**
- A turn that ignores the abort. The App test covers the second-`/exit`
  escape, but there was no e2e with a real hung tool.
- The 10 s give-up against a real stalled mount. Only the unit test with a
  never-settling `save` covers it.

## Review

*— claude-opus-5-5, 2026-10-20*

**Verdict: APPROVE-WITH-NITS.** The store is now atomic, serialized per uid
(latest wins), loud on bad files, and its failures no longer crash the TUI. I
checked each of these by running it, not only by reading the tests. No finding
below shows a regression or a §7 violation. The main gap is #1: the `main.ts`
wiring that closes F5 (drain at exit) and the in-TUI resume warning is not
pinned by any test. The end-to-end trace shows it works today, but a mutation
that removes it passes the whole cli suite.

**Reviewer honesty:** same model as the executor (claude-opus-5-5), fresh
context only. Shared blind spots may survive both passes. For a `load-bearing`
task, a different model's pass would add real independence.

### Findings

1. **Low-Medium — the F5 closure and the resume notices in `main.ts` are
   unpinned.** Mutations R8 (drop `await finishSaves(saver)`, worker path,
   `packages/cli/src/main.ts:515`), R9 (same, pod path, `:335`) and R10 (drop
   `notices.notify` of resume warnings, `:294-296`) each leave
   `bun test packages/cli/test` green (129 pass). The Tests section says the
   `local-runtime.test.ts` "no sleep" test "pins F5". That is overstated: it
   pins that `SessionSaver.drain` waits for the write, not that any TUI path
   calls it. The e2e trace below shows the wiring works now, but a refactor
   could drop it silently. Fix: extract the TUI-path teardown (dispose → drain
   → print) into a small tested function, or add a `main()`-level test with an
   injected `startTui`. Otherwise, correct the claim in Tests/Execution.
2. **Low — a throwing teardown skips the drain.**
   `finally { await runtime.dispose(); await finishSaves(saver); }`
   (`main.ts:334-335`, `:514-515`; `:557-558` with `mcp.dispose()`). If
   `dispose` throws, the pending writes are dropped at `process.exit` and the
   unsaved-session lines are never printed. Today `dispose` looks non-throwing
   (`closeSessions` is timeout-raced, `remote-client.ts:239-252`), so this is
   latent. Fix: nest the drain in its own `finally`.
3. **Low — the exit drain has no bound and prints nothing while it waits.**
   `SessionSaver.drain` (`session-saver.ts:85`) and `JsonSessionStore.drain`
   (`session-store.ts:274`) wait without a limit. A hung write (stalled
   NFS/FUSE mount) leaves a frozen terminal after the TUI is gone, with no
   message saying why. Before this change, exit did not wait at all. Ctrl+C
   still works (no handler is installed after unmount). Fix: a timeout plus a
   `[session] still saving…` line.
4. **Low — crash leftovers pile up.** In my SIGKILL run, 6 kills left 3 stray
   `.big.json.tmp-*` files, and the executor's 20 kills left 5. Each one is a
   full history copy. They are removed only by `list()`
   (`session-store.ts:319`, `:348`), which runs only on a bare `--resume`, and
   only once they are more than 1 h old. A user who never runs bare `--resume`
   keeps them forever (hidden dot-files, mode 0600). Fix: also sweep stale
   temps on the first `save` of a process, or accept and note it under
   Notes/debt.
5. **Nit — save-failure messages name the hidden temp file.** The notice and
   the drain line read `EACCES: permission denied, open '…/.x.json.tmp-36694-fd797ae9'`
   (seen e2e). The user is pointed at a file that no longer exists, not at
   `<uid>.json` or the directory. The temp is created at
   `session-store.ts:263`. Fix: wrap the error with the target path.
6. **Nit — the reason given for one drift is not shown.** Execution says
   `SessionSaver.drain` waits on its own handlers because "awaiting the store
   alone could report a stale state". Mutation R7 (`drain` → `await
   this.store.drain()`) passes all 5 saver tests. The waiters resolve before
   the pump's promise, so the microtask order seems to make the store-only
   version work. The code as built is the safer of the two, but no test pins
   it, and "could report stale" was never demonstrated.
7. **Nit — prior-art docs are stale.** `docs/eval/attachments.md:137-139` and
   `docs/eval/history-validity-invariant.md:47-48` still describe `load` as
   "an unvalidated cast". The new strict message check
   (`session-store.ts:109`) means a future `attachments` message field MUST be
   added to `MESSAGE_KEYS`. Otherwise every new file becomes unreadable, which
   is fatal on an explicit `--resume`. The tripwire
   (`packages/cli/test/session-resume.test.ts:117`) catches this, provided the
   wire schema changes in the same commit. attachments.md already says "§4 can
   add `attachments`", so it is not contradicted, only out of date. Refresh
   both when either is promoted.
8. **Note (existing before this change, not in the failure-mode table).**
   `/exit` is accepted while a turn is running (`tui/src/commands.ts:30` only
   blocks `/retry` and `/clear`). The in-flight turn is then never saved:
   on the worker path the snapshot hits a closed session, and on the
   in-process path `process.exit` comes before `Session.persist`. F5 holds as
   written ("no save in flight at exit"), but the doc should list this case.
   Not checked by running it in this review. To check: use a slow mock model,
   send `/exit` mid-stream, and diff the file.
9. **Not verified — the strict validator against the user's real 53 session
   files.** The permission classifier refused copying
   `~/.config/tentacle/sessions` into the review dir. By reading the code, the
   risk is low: core `ChatMessage` has exactly the 4 checked keys
   (`core/src/model.ts:20-34`), both providers build exact 3-key `toolCalls`
   (`openai-provider.ts:94`, `anthropic-provider.ts:243-246`), and uids are
   `randomUUID`. To check: run `new JsonSessionStore(dir).load(id)` (NOT
   `list()`, which deletes stale temps) read-only over each file and expect 0
   `unreadable`.

### Gate (re-run by the reviewer)

`bun run check` → exit 0. `tsc --noEmit` clean. `biome check .`: "Checked 283
files … No fixes applied" (0 errors, 0 warnings). **1006 pass, 2 skip, 0
fail** (1008 tests, 106 files, 29.2 s). The two skips are the opt-in live-k8s
and slow-keepalive tests (baseline). These numbers match Execution step 11.

### Premise table

| # | Premise (as cited) | Checked | Verdict |
|---|---|---|---|
| 0 | Context symptom on `main` (repro (a)/(e)/(b)) | `review/repro.ts old` with `git show main:…/session-store.ts`: `load(newest)=null`, `list=["zzz","old"]`, **`latest = zzz messages: undefined`**; 20 overlapping pairs **corrupt=8 olderWon=10**. `voidsave.ts old` (interval shape, chmod 555 dir) → raw stack, **exit=1** | TRUE (reproduced) |
| 1 | `session-store.ts:63-66` in-place `Bun.write`; `:69-79` catch→null; `:82-105` list; `:108-110` latest (main) | `git show main:` | TRUE |
| 2 | `local-runtime.ts:141-148` `void deps.store.save`; flush `:76-81`, send `finally` `:84-89`, compact `:90-94` (main) | idem | TRUE |
| 3 | pod runtimes go through `createLocalRuntime` `pod-runtime.ts:276`, `:462` | idem | TRUE |
| 4 | in-process `main.ts:519-526` `void store.save`; `session-jobs.ts:85-88`, `:117`; `session.ts:50-52`, `:74`, `:105` | idem | TRUE |
| 5 | resume readers `main.ts:275-293`, `:460-473` (two copies) | idem | TRUE |
| 6 | busy slot `hosted-session.ts:394-402` | idem | TRUE |
| 7 | in-process `Session.compact` has no guard (`session.ts:91-106`) | idem | TRUE |
| 8 | `rg unhandledRejection` → only test spies | now `remote.test.ts:1344` + the new `session-saver.test.ts:61` | TRUE |
| P1 | one writer, call sites exactly the two above | `rg JsonSessionStore packages/*/src` → only `main.ts:282` constructs one | TRUE |
| P4 | `pushNotice` (`App.tsx:319-327`) is "the existing notice renderer" | it appends `kind: "assistant"` | PARTLY FALSE: Execution caught this and drifted to `appendNotice` (correct) |
| P5 | wire `ChatMessageSchema` strict (`protocol/src/session.ts:28-35`), used at `:244` | read | TRUE; the hand-rolled mirror matches it key for key |
| P6 | `daemon-side-persistence.md:392-399` assumed interface | read | TRUE, see attack (e) |

### Mutation non-vacuity (reviewer's own set; each reverted, `assert bytes == orig`)

| Mutation | Test file | Result |
|---|---|---|
| R1 write the target directly, no rename | session-store | RED (interrupted write) |
| R2 `save` → `writeAtomic` directly (no queue) | session-store | RED ×4 (overlapping, coalesce, shared reject, drain) |
| R3 parse error → `absent` (main's behaviour) | session-store | RED (truncated newest) |
| R4 accept unknown message keys | session-resume | RED (mirror row `extra:true`) |
| R5 saver `void store.save` | session-saver | RED ×4 |
| R6 failing→failing notifies again | session-saver | RED ×2 |
| R7 saver drain = `store.drain()` only | session-saver | **GREEN (survived)**: finding 6 |
| R8 / R9 drop `finishSaves` (worker / pod) | cli/test | **GREEN (survived)**: finding 1 |
| R10 drop resume `notices.notify` | cli/test | **GREEN (survived)**: finding 1 |

`git diff | shasum` was `bb6b728d…` before and after all mutations.

### Attacks tried

- **(a) §7 persistence on the laptop: holds.** The only store is built in
  `main.ts:282` on the main thread. The pod paths pass the laptop `saver`
  into `createLocalRuntime`. The record uid comes from the laptop
  (`local-runtime.ts:139`), so a pod cannot pick the file name. Messages a pod
  sends are validated twice (wire schema plus `parseSessionRecord` on load).
  No daemon-side write was added.
- **(b) §7 no raw terminal writes while Ink is mounted: holds.** The resume
  lines are written pre-mount (`openSessions`). Save failures go hub → App
  (`appendNotice`) and never `write`. The drain lines come after `startTui`
  returns, and its `finally` has already left the alt-screen. E2E byte offsets
  in the pty capture: `ESC[?1049l` at 2161, then `[session] not saved` at
  2169. The failure path is the same `finally`. The hub never writes.
- **(c) queue correctness (`review/queue.ts`, gated `writeDurable`): holds.**
  A fails, B and C queue behind it, D arrives during C's write. Result: `A:ENOSPC
  B:ok C:ok D:ok`, file `updatedAt=4`, 0 temps. B coalesced into C and did not
  inherit A's failure. Two uids, with b released first, settle `b,a`
  independently. A save submitted after `SessionSaver.drain()` started is
  still awaited and reported (2 lines). fail → ok → fail gives exactly 3
  notices and 1 drain line. A throwing listener plus failing saves gives **0
  unhandled rejections**. The slot delete in `pump` follows the `while` check
  with no `await` between them, so no save can land in a deleted slot.
- **(d) no loud→silent conversion: holds.** A truncated or wrong-shape file
  is now reported (pre-mount line and in-TUI notice) and never wins.
  `--resume <uid>` on a bad file is fatal and names the file. Re-ran repro
  (a)/(e) on the branch: `latest = old`, `skipped=[newest,zzz]`, overlapping
  pairs **corrupt=0 olderWon=0**. SIGKILL in a loop saving a 40 MB record, 6
  runs: **corrupt=0** (main: 1/6 per the Context). The only new silence is
  finding 3 (a hung drain).
- **(e) next child's contract (`daemon-side-persistence.md:392-399`):
  satisfied.** Atomic: yes. Serialized latest-wins per uid: yes (in-process
  only, F10). Rejects instead of crashing: yes. `load` corrupt vs absent:
  `LoadResult`. `list` skips and reports: yes. Extra top-level fields kept
  verbatim: yes (test plus validator). `DaemonSessionRecord`'s additions
  (`kind`, `turnIds`, `turn{…}`, `daemon-side-persistence.md:427-440`) are all
  top-level. Constraints the child must know: (i) messages are **strict**, so
  no per-message extra fields; (ii) `load`/`list` are typed `SessionRecord`,
  so the child needs its own `parseDaemonRecord` (it already plans one, `:647`);
  (iii) `SessionSaver` lives in `cli` and imports a `tui` type, so the daemon
  must handle `save` rejections itself.
- **E2E through the real CLI** (pty via `script`, mock OpenAI SSE server,
  `TENTACLE_CONFIG_DIR` scratch):
  - worker path with a `chmod 555` sessions dir: one turn shows the in-TUI
    "…continues; tentacle retries after the next turn." notice. On `/exit`,
    `[session] not saved: <uid> — EACCES…` prints after leaving the
    alt-screen, with exit 0 and no stack.
  - `-i --in-process` with a writable dir: after `/exit`,
    `<uid>.json` (mode 0600) holds `[system, user:hi, assistant:pong]`.
  - `--resume` with a truncated newer file plus a valid one: the pre-mount
    `[resume] ⚠ Skipped 1 unreadable…` line, then `[resume] good1 — the good
    one`. The same warning appears in the TUI frame.
- **Path traversal:** `SAFE_ID` (`session-store.ts:96`) is checked in `load`,
  `writeAtomic` and first in `resolveResume`. A leading dot or separator is
  rejected. Holds.

### What holds

The load-bearing assumption (same-directory rename, shown by running it), F1,
F2, F3, F4, F7, F8, F9, F11 and F12, all checked above. Test quality is good:
the red runs were shown, and the store/saver mutations are all killed except
R7.

### How the executor behaved

Disciplined. It showed the store tests failing before the fix, re-ran the
Context repro on `main`, and ran a real-CLI trace that found and fixed a
defect (the misleading path for an invalid id). Its drift was reported
honestly (`appendNotice` instead of `pushNotice`, the saver's own drain set,
the throwing-listener guard). Its gate numbers match mine exactly. Two weak
spots: "pins F5" claims more than the test proves (finding 1), and one drift
rationale was argued rather than demonstrated (finding 6).
