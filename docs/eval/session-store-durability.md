# eval/session-store-durability — is session persistence crash-safe, and are its failures visible?

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes if promoted (touches the §7 "persistence lives on the laptop/main thread" invariant and the persisted format's read path); mandatory fresh-context Review.

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

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

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
