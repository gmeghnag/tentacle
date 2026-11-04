# fix/attach-plain-resume — `attach` to a plain kept container reopens the run's conversation

> **Status:** round 3 reviewed, APPROVE-WITH-NITS (1 LOW: symlinked-path key after delete)
> **Branch:** `fix/attach-plain-resume`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module · **Suited:** a stronger model + fresh-context Review (a field in the persisted kept-index entry, the saver, the attach path of `main.ts`)

## Context

*— claude-sonnet-5-5, 2026-11-04*

Owner, live 2026-11-04: `tentacle run --engine docker --image=… --profile deepseek "ciao"`,
`/quit` (kept by default), then `tentacle attach tentacle-ba89d072` → an EMPTY new
session; the conversation of the run is not shown. Under
`~/.config/tentacle/sessions/trash-<hash>/` every attach created a NEW 3-message record.

Cause: the kept index entry (`kept.ts:33-57`, `KeptEntry`) records no session id for a
plain (non-detached) run; only the relay's `owner.json` has `sessionId`. The pod
daemon's session ends at `/quit` (pod daemons never persist, AGENTS §7), and
`planAttach` gives `plain` without an owner record (`attach-plan.ts:48-50`), so the
attach goes on to `openSessions(attachFlags, attachBools)` (`main.ts:~1432`) with no
`--resume`: `resume: null`, a fresh session.

Decision (owner): `run` writes the session uid into the kept index entry (laptop-written,
never pod-supplied; updated when the session changes: `/clear`, `/resume`);
`attach` to a plain kept container reopens that session from the LAPTOP record with full
history — the path a closed detached session already uses (`docs/attach-detach-behaviour.md`).
Entries without an id (older runs) keep today's behaviour. `--resume <uid>` / `--continue`
on attach still win. The record lives in the run's folder (attach-any-folder).

**Repro** (2026-11-04, current `main`): the new tests, before any source change (see
Execution).

## Implementation

*— claude-sonnet-5-5, 2026-11-04*

### Load-bearing assumption

The uid we write and later reopen is chosen by the LAPTOP, and the file it lands in is
the laptop's. Proven:

- The uid: `createSession` takes `record?.id ?? firstId ?? crypto.randomUUID()`
  (`local-runtime.ts:~620`), passed into `session/open` (`build`, `local-runtime.ts:567-580`);
  the saver is fed `recordFromSnapshot({ id: uid, … })` (`local-runtime.ts:588-591`) —
  `id` is that laptop-chosen `uid`, never a value read from the pod (the pod supplies only
  `messages`). So `SessionSaver.save(record).id` is laptop-originated.
- The file: `recordKept` writes `<configDir>/kept/<hash>.json`, mode 0600, atomically
  (`kept-index.ts:50-70`) — the laptop's config dir; nothing in a pod's reach writes it
  (it is the same file that already carries `mount`, trusted for the folder by
  attach-any-folder).
- Reading back is by `readSessionRecord(where, uid)` → `JsonSessionStore(root/<projectKey(cwd)>).load(uid)`
  (`tui-sessions.ts:~136-146`): a validated uid (`isValidSessionId`, `session-resume.ts:~55`)
  inside the run's own folder's directory. A forged or stale id can at most name a session
  of this same folder, or nothing.

### Preconditions

- Plain attach opens its sessions in `main.ts` attach (`openSessions`, `main.ts:~752-770`),
  after `moveTo(keptEntry.mount)` (`main.ts:~1385`): `config.cwd` is already the run's folder.
- `openTuiSessions` with an explicit uid: absent → non-fatal "starting fresh"; **unreadable
  → fatal**; **in another project → fatal** (`session-resume.ts:56-82`). Neither is wanted
  for an IMPLICIT uid (the user did not ask for it), hence the pre-check below.
- `recordKept` of an existing entry replaces its file (`keptFileName` = hash of
  location+name, `kept-index.ts:29-33`); `parseKeptEntry` rebuilds an entry field by field
  (`kept.ts:~165-185`), so an unknown optional field is dropped by an old build — additive.
- A non-listed (`keep=false`) plain run has NO index entry (`listed`, `main.ts:~960`):
  nothing to write, nothing to attach to.
- `SessionSaver.save` is called synchronously on every committed turn
  (`local-runtime.ts:588`); `/clear` makes a new uid on its next saved turn.

### Design

- `kept.ts`: `KeptEntry.sessionId?` (optional; parsed only if `isValidSessionId`, else
  dropped — a bad value never refuses the entry).
- `kept-index.ts`: `setKeptSession(dir, entry, sessionId)`: READ the entry's file now;
  only if it parses and its `created` equals `entry.created` (this workload's, not a
  re-recorded name's; and not resurrected after `tentacle rm`) rewrite it with the id
  (atomic `recordKept`); else no-op. `trackKeptSession(saver, dir, entry, onError)`:
  registers a saver observer that calls it when the saved uid differs from the last one
  written (starts at `entry.sessionId`); a failure → `onError` once, never thrown into the
  saver.
- `session-saver.ts`: `observe(listener)`; called from `save` (after the `removed` guard),
  its throw swallowed.
- `attach-plan.ts`: pure `plainResumeUid(entry, flags)` → the entry's `sessionId`, unless
  the command has `--resume [uid]` or `--continue` (they win), or there is no id.
- `main.ts`:
  - `run` (TUI path only, not detach): after `recordKeptEntry(keptName)`,
    `trackKeptSession(sessions.saver, …, keptEntryFor(keptName), notice)`.
  - plain `attach` of a kept entry: `plainResumeUid` → `readSessionRecord` (in the
    already-moved folder). A record → `openSessions` with `resume=<uid>` (resume record
    seeds the runtime and the TUI history, as `--resume <uid>`). `null`/unreadable → today's
    fresh session plus ONE in-TUI notice (`sessions.notices`), never fatal. Then
    `trackKeptSession` for the attach too, so `/clear` in an attach is also the "latest".
- Same-folder limit: a no-`mount` entry (k8s, `--no-mount`) has no recorded folder
  (attach-any-folder), so a record filed under the run's folder is found only when attached
  from it; from elsewhere: the notice, fresh session. Left (Notes).

### Files

`packages/cli/src/kept.ts`, `kept-index.ts`, `session-saver.ts`, `attach-plan.ts`, `main.ts`;
tests `kept.test.ts`, `kept-index.test.ts`, `session-saver.test.ts`, `attach-plan.test.ts`,
`main.test.ts`; docs `docs/attach-detach-behaviour.md`, `TODO.md` untouched.

### Failure modes

- Record file gone / unreadable / of another folder → fresh session + one notice; exit 0.
- Entry of a re-used name (new `run` re-recorded it): the old id is gone with the old file;
  `setKeptSession` of a stale process refuses on `created` mismatch.
- `tentacle rm` while the run's TUI is open: its next save finds no file → no resurrection.
- Two terminals attach the same container: both reopen the same uid (as two
  `--resume <uid>`); each tracks; the last writer's id wins, and the saver's Q6 guard
  already keeps the longer history. Converges to "the latest".
- `/clear` then quit → the new id is recorded when its first turn is saved; a `/clear` with
  no turn keeps the previous id (nothing newer exists).
- Index write fails (EACCES, ENOSPC) → one in-TUI notice; the conversation continues.
- Old entry (no id): today's fresh session. Corrupt `sessionId` in the file: dropped.
- `--resume <uid>` / `--continue` / bare `--resume`: the explicit request, unchanged.

### Tests

- `kept.test.ts`: a valid `sessionId` round-trips; an invalid one is dropped, entry kept.
- `kept-index.test.ts`: `setKeptSession` writes; same id no rewrite; absent file → no
  resurrection; `created` mismatch → untouched; `trackKeptSession` records the NEW uid on
  a change and swallows a failing write into `onError` once.
- `session-saver.test.ts`: `observe` sees each saved record; a throwing listener does not
  break `save`.
- `attach-plan.test.ts`: `plainResumeUid` table (id; flags win; no id).
- `main.test.ts`: plain attach with an id and a record → the runtime gets `resume` with the
  record (history); id but no record → fresh + notice, exit 0; id of a record in another
  folder → same; `--continue` wins; no id → unchanged.

## Execution

*— claude-sonnet-5-5, 2026-11-04*

1. Stubs for the new symbols (signatures only), then tests
   (`attach-plain-resume.test.ts`, `main.test.ts`). Red on the assertions, not on imports:
   unit file 3 pass (vacuous on stubs: flags-win, saver-remove, no-resurrect) / 6 fail;
   `main.test.ts` 4 new fail (run records the id; attach reopens; record gone/unreadable/
   other folder; attach follows `/clear`).
2. Source per Design: `kept.ts` (`sessionId`, validated on parse), `kept-index.ts`
   (`setKeptSession`, `trackKeptSession`, `keptSessionNotice`), `session-saver.ts`
   (`observe`), `attach-plan.ts` (`plainResumeUid`), `main.ts` (run: tracker on
   `recordKept` of the TUI path; plain attach: pre-check with `readSessionRecord`, then
   `openSessions` with `resume=<uid>`; tracker also on attach).
3. Drift: (a) tests for the units live in a new file, not spread over four (the shell here
   could not append to existing ones); (b) the "failing index write" test uses a
   read-only dir (`chmod 0500`), because a vanished file is "gone", not a write failure;
   (c) `interactive`/`attached` helpers in `main.test.ts` gained `saves`/`resume`/
   `notices`/`saver` capture, and the run helper drops the sessions it wrote.
4. Mutations (one each, reverted; `shasum -c` OK on the 5 source files):
   | # | Mutation | Red |
   |---|---|---|
   | M1 | `plainResumeUid` never returns the id | 3 |
   | M2 | `plainResumeUid` ignores `--resume`/`--continue` | 2 |
   | M3 | no record pre-check | 1 (gone/unreadable/other folder) |
   | M4 | `setKeptSession` skips the `created` check | 1 |
   | M5 | run does not track | 1 |
   | M6 | attach does not track | 1 |
   | M7 | saver lets a listener throw | 1 |
   | M9 | parse keeps an unvalidated id | 1 |
   | M8 | tracker rewrites on every save | 0 — equivalent: `setKeptSession` already skips an identical id, so the tracker's own compare only saves a file read |
5. Gate (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` clean (621 files,
   after `--write` on two formatting nits); `bun test packages` 4324 pass / 3 skip (opt-in) /
   0 fail. A first full run had one failure, `engine-runtime.test.ts` "attach: a dropped
   link: one line with the log path" (timing; the file alone 89/0 and a second full run
   green) — unrelated to this change, not investigated further.

Unverified: a real `run` + `/quit` + `attach` on Docker (needs the owner's environment).
Known limits: a no-`mount` entry (k8s, `--no-mount`) has no recorded folder, so its record
is found only when attached from the run's own folder (else the note + a fresh session); a
`/clear` with no turn keeps the previous id (no newer record exists).

## Review

*— claude-opus-5-5, 2026-11-04* (fresh context; a different model from the executor,
claude-sonnet-5-5, but the same family, so blind spots the two share could survive both passes)

**Verdict: APPROVE-WITH-NITS (PASS).** All findings are LOW.

**Findings (all LOW)**

1. *Test gap: bare `--resume` on attach.* `main.ts:1440` counts
   `attachBools.has("resume")` as an explicit choice, and the code is correct. No test
   pins it, though. My mutation (drop the `attachBools` half) left
   `main.test.ts` + `attach-plain-resume.test.ts` **110/0 green**. Under that mutation,
   `attach box --resume` would silently reopen the entry's session and skip the picker.
   Add one case: `attach box --resume` (bare) gets no implicit uid.
2. *The reopen test asserts the runtime, not the screen, and only for one turn.*
   `main.test.ts` "the entry's session is reopened…" checks `deps.resume` with 2
   messages (one turn). It does not check the TUI's `resumeMessages`
   (`tui-sessions.ts:165`). My E2E probe (below) closes this. The test could also
   capture `resumeMessages` from a 2-turn record.
3. *Gate environment (not this diff).* In this worktree `apps/mobile` has no deps, and
   that has two effects. First, `tsc -p apps/mobile` fails (`expo/tsconfig.base` not
   found). Without that base it also **emits `.js` files** into `apps/mobile`
   (`App.js`, `src/*.js`, `test/rn-websocket.test.js`), which then break lint and add a
   test failure. I deleted the 6 files my run created (all timestamped at the gate run).
   Second, `apps/mobile/test/rn-websocket.test.ts` cannot resolve `@tentacle/client`.
   This is worth a TODO line: a worktree gate needs `bun install` in mobile, or a
   `--filter`.

**Gate** (foreground; re-run once on a clean tree after removing the files from finding 3):
root `tsc --noEmit` clean, and the mobile `tsc` fails for the environment reason in
finding 3. `biome check .` reports 621 files, clean. `bun test` gives 4363 pass,
3 skip (the opt-in ones) and 1 fail plus 1 error, all from
`apps/mobile/test/rn-websocket.test.ts` (module resolution, outside the diff).
`attach-plain-resume.test.ts` alone: 9/0.

**Mutation** (one, mine): `main.ts:1440`, with the bare-`--resume` check removed. It
**survived** (finding 1). I reverted it, and `shasum -c` reports `main.ts: OK`
(byte-identical).

**E2E trace** (`.tentacle/tmp/attach-plain-resume-review/probe.test.ts`, real `main`
with only the engine runtime and `startTui` faked):

1. A kept entry `{sessionId: A, mount: folder}` plus a **2-turn** record A (4 messages)
   in `folder`, then `attach box`. The TUI's `resumeMessages` were
   `[ciao, salve, secondo, "turno due"]`.
2. The attach's saver then saves uid B (`/clear` + one turn), and the index reads `[B]`.
3. A second `attach box` gets the TUI history `["dopo clear"]`.

The probe passed with 3 expects.

**Premise table**

| Premise | Result |
|---|---|
| Symptom: a plain attach got `resume: null` (no id in `KeptEntry`; `planAttach` gives `plain` for `owner.kind === "none"`, `attach-plan.ts:48-50`) | TRUE |
| uid is laptop-chosen: `record?.id ?? firstId ?? randomUUID()` (`local-runtime.ts:615`), `firstId = deps.sessionId` (`:558`, laptop: owner.json/none); saver gets `{ id: uid, messages }` (`:588-591`); the in-process path's `persist` (`main.ts:1596`) likewise | TRUE |
| `recordKept` is atomic, mode 0600, in the laptop config dir (`kept-index.ts:50-67`); the only writers are `main.ts:984` and the new `setKeptSession` | TRUE |
| explicit uid: absent → non-fatal; unreadable / another project → fatal (`session-resume.ts:54-85`), hence the pre-check | TRUE |
| `parseKeptEntry` rebuilds field by field, with no unknown-key refusal (`kept.ts:146-185`), so the new field is additive with no schema bump | TRUE |
| the detach path's `recordKept` (`main.ts:1025-1029`) has no tracker; the detached `run` attach path (`main.ts:1336-1412`) returns before the new code | TRUE |

**Attacks tried**

- *§7: could a pod supply the id?* No. Every `saver.save` site uses the laptop uid. A
  forged or bad value in the file is dropped by `isValidSessionId`, and it can only
  name a record in the run's own folder (`readSessionRecord` under
  `projectKey(config.cwd)`). Holds.
- *Reused name or `rm` while a TUI is open.* `setKeptSession` re-reads the file and
  checks `created`, so there is no resurrection and no write to the newer entry
  (executor's M4). The attach of a re-recorded entry gets no old id (test). Holds.
- *Missing, unreadable or other-folder record.* Each gives a fresh session, ONE note
  and exit 0 (test and executor's M3). Holds.
- *`--resume <uid>` and `--continue` override.* Tested. Bare `--resume` is correct but
  untested (finding 1).
- *Detached runs.* The plan's `run` kind returns before the new code. A plain fallback
  on a detached run (owner `unknown`, a `created` mismatch, a different `--resume`)
  only reads an id that this laptop wrote. Its `resumeUid` case is excluded by
  `plainResumeUid`. Unchanged in effect.
- *Old entries.* No id means today's fresh session with no note (test). An old build
  reading a new entry drops the field. Holds.
- *Two terminals.* Both reopen A, and the last writer's id wins. This matches two
  `--resume A` today, and the saver's Q6 guard keeps the longer history. Accepted.
- *Two trackers per process* (a `recordKept` retry on another name). Each writes only
  its own entry file, and a forgotten file is a no-op. Harmless.

**What holds:** the §7 laptop-only property, the `/clear` follow (run and attach),
reused names, the override flags, detached runs and old entries.
**Unverified:** a real Docker `run` → `/quit` → `attach` (needs the owner's environment).

**Executor behaviour:** the stubs → red → green sequence was documented. There were 9
honest mutations, including one declared equivalent (M8) with a reason. The drift
(a new test file, the `chmod` failure test) was stated. The gate claim was scoped to
`bun test packages`, which is consistent with finding 3. One flaky failure was
reported, not hidden. No overreach outside the plan's files.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

Owner decision: the Known limit (no-`mount` entries: the record is found only from the
run's own folder) is closed — `attach` works from ANY folder (fix/attach-any-folder).

1. `KeptEntry.cwd?` (`kept.ts`): the laptop folder `run` was launched from, every engine;
   `keptEntryFor` writes `cwd: config.cwd` (`main.ts`; laptop-written, never from a pod).
   Parsed like `mount` (`opt("cwd")`): an entry without it still parses (backward-readable,
   no `KEPT_SCHEMA_VERSION` bump, same additive rule as `sessionId`).
2. Plain `attach`: `moveTo(keptEntry.mount ?? keptEntry.cwd, "container")`. The mount stays
   the source when present (docker/podman); `cwd` only when there is none (k8s,
   `--no-mount`); neither (older entry, explicit flags) = the launch folder, as before. A
   `cwd` that is gone gives the same one line as a gone mount.
3. Review LOW closed: `attach --resume` without a uid (no terminal: newest session) is tested.
4. Tests first, red on the assertions: `KeptEntry.cwd` round trip, run records the folder,
   a no-mount entry reopens from its `cwd` (and the gone-folder line). The bare-`--resume`
   and mount-wins tests are green on the pre-existing/previous behaviour; their
   non-vacuity is the mutation (N5, N2).
5. Mutations (one each, reverted; `shasum -c` OK on `main.ts`, `kept.ts`):

   | # | Mutation | Red |
   |---|---|---|
   | N1 | attach ignores `cwd` (`moveTo(mount)`) | 1 |
   | N2 | `cwd` preferred over `mount` | 1 |
   | N3 | run does not record `cwd` | 1 |
   | N4 | parse drops `cwd` | 3 |
   | N5 | bare `--resume` not seen as a resume flag | 2 (bare + uid/continue) |
6. Gate (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` clean (621
   files); `bun test packages` 4328 pass / 3 skip (opt-in) / 0 fail.

Unverified: a real k8s `run` + `/quit` + `attach` from another folder.

## Review — round 2

*— claude-opus-5-5, 2026-11-04* (fresh context; a different model from the executor,
claude-sonnet-5-5, but the same family)

**Verdict: REQUEST-CHANGES.** There is one MEDIUM and one LOW finding. If the owner
confirms that the refusal in finding 1 is intended, it becomes an accepted design and
the verdict is PASS.

**Findings**

1. **MEDIUM: a k8s attach (no mount) is now refused when the run's laptop folder is
   gone.** `main.ts:1421` gives `moveTo(keptEntry.mount ?? keptEntry.cwd, …)`, and
   `moveTo` (`main.ts:1258-1266`) exits 1 when the folder is not a directory.
   Before this round, an entry with no mount gave `moveTo(undefined)`, which returns
   `true`, so the attach always worked. Now a renamed or deleted launch folder makes
   `tentacle attach <name>` refuse a LIVE pod, whose code and work are in the pod. For
   a mount that refusal is justified, because the container's workspace IS that
   folder. For `cwd` it only decides where the session record is filed. The test pins
   the refusal as intended (`main.test.ts:1880-1886`), and the line names no way
   around it (explicit flags skip the index). Suggested change: when only `cwd` is
   used, a gone folder means the launch folder plus ONE note ("conversation not
   reopened: <folder> is gone"), exit 0. That is round 1's behaviour, and it degrades
   instead of blocking. **Owner decision needed.**
2. **LOW: one test title claims more than it tests.** "…an older entry (neither) keeps
   the launch folder" (`main.test.ts:1891`) only exercises mount + `cwd`. The
   neither-field case is structurally trivial (`moveTo(undefined)` → `true`), but no
   test in this branch pins it.

**Requested checks**

- *§7, laptop-written only.* `cwd` is set in `keptEntryFor` from `config.cwd`
  (`main.ts:977`), and the only kept writers are `recordKept` (`main.ts:984`) and
  `setKeptSession`, which spreads the parsed laptop file. Nothing comes from a pod. It
  is printed through `untrustedText`. **Holds.**
- *Old entries without the field.* `opt("cwd")` (`kept.ts:183`) is optional and there
  is no unknown-key refusal, so the entry parses (executor's N4). With neither field,
  `moveTo(undefined)` gives the launch folder as before. **Holds** (see finding 2).
- *Mount wins on docker/podman.* With `mount` plus a `cwd` that does not exist, the
  config cwd is the mount and the session reopens (`main.test.ts:1891-1908`, N2).
  **Holds.**
- *k8s attach from another folder.* With no mount and `cwd: folder`, an attach from
  the test's launch folder gets `config.cwd === folder` and `resume.id === A`, with no
  notes (`main.test.ts:1867-1878`). **Holds.** Bare `--resume` is now tested
  (`:1857`), which closes round 1's finding 1.

**Mutation** (one, mine): the session pre-check reads in `process.cwd()` instead of the
moved `config.cwd` (`main.ts`, `readSessionRecord` in the plain attach). It was
**killed**: 3 tests red (reopen in the run's folder, k8s from ANY folder, mount wins).
I reverted it, and `shasum -c` reports `main.ts: OK`.

**Gate** (once, foreground): root `tsc --noEmit` clean. `biome check .` reports 621
files, clean. `bun test packages` gives **4328 pass, 3 skip (opt-in), 0 fail**. I
skipped the mobile `tsc` so it would not emit `.js` again (round 1, finding 3).
`git status` shows only the task's files.

**Executor behaviour:** the round was minimal and in scope (`kept.ts`, one line in
`keptEntryFor`, one in `moveTo`, plus tests). It had 5 mutations with honest red
counts, and was candid that two tests were green before the change (their
non-vacuity rests on N2/N5). The gone-`cwd` refusal was a deliberate choice, stated in
Execution, but it was not weighed against the k8s regression it causes.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-04*

Owner decision (2026-11-04, every engine): `attach` works even if the run's laptop folder no
longer exists. The folder only keys the laptop session store (`sessions/<projectKey(path)>/`,
derived from the path string; `projectKey` already falls back to the resolved path for a
missing directory), so the session is filed under the ORIGINAL path. This supersedes the
"folder gone: one line, exit 1" rule of `docs/fix/attach-any-folder.md` (kept there as
history).

1. `moveTo` (`main.ts`): the `statSync` existence check and its `[error] … no longer
   exists` line are removed (the `what` parameter and the `node:fs` import with them). It
   now only reloads the config for the folder; the one remaining refusal is a project
   config that does not load. `planAttach` never had a folder check (it only carries `cwd`).
2. Nothing else assumes the folder exists on the attach path: `loadConfig({cwd, scaffold:
   false})` tolerates a missing dir (tests); `config.cwd` is only passed as a string
   (`attachCwdWarning` compares strings; `recordFromSnapshot`, `openTuiSessions`,
   `readSessionRecord` key the store by it); the store dir under `~/.config` is created by
   the store as usual. No chdir, no mkdir of the folder, no `.tentacle/` read of it.
3. Tests first, red on the assertions (3 fail): run folder gone → exit 0, `config.cwd` the
   original path, session id passed; plain mount gone → `--continue` says `no saved sessions
   for <missing>`; no-mount `cwd` gone → the record filed under the missing path is reopened,
   no note. Review LOW fixed: the "mount wins" test is retitled and now also pins the
   neither-field case (launch folder, nothing reopened).
4. Mutation (one, reverted; `shasum -c` OK on `main.ts`): re-adding a refusal for a vanished
   folder → the 3 tests above red.
5. Docs: `README.md` (attach from any folder, folder may be gone),
   `docs/feat/detached-handover.md:498`. `docs/attach-detach-behaviour.md` does not exist in
   this tree. The Known limit and "Failure modes" lines about a gone folder in this doc's
   Implementation/round 2 are superseded by this note.
6. Gate (once, foreground): `bunx tsc --noEmit` clean; `bunx biome check .` clean (621
   files); `bun test packages` 4328 pass / 3 skip (opt-in) / 0 fail.

Unverified: a real attach after deleting the run's folder (needs the owner's environment).

## Review — round 3

*— claude-opus-5-5, 2026-11-04* (fresh context; a different model from the executor,
claude-sonnet-5-5, but the same family)

**Verdict: APPROVE-WITH-NITS (PASS).** One LOW finding.

**Round-2 MEDIUM: closed.** `moveTo` (`main.ts:1252-1273`) no longer runs `statSync` or
prints the "no longer exists" refusal. It only reloads the config, and its one
remaining `false` is a project config that does not load. Both callers (`plan.cwd` for
a detached run, `mount ?? cwd` for a plain one) lost only the `what` argument.

**Requested checks**

- *Nothing chdirs into or needs the vanished folder.* There is no `process.chdir` and
  no `mkdir`/`join` of `config.cwd` in `packages/cli/src`. Laptop-side
  `connectMcpServers` runs only on the in-process paths (`main.ts:1576`, `worker.ts`,
  `wiring.ts`), never on attach. The engine runtimes pass `config.cwd` as a string
  (`engine-runtime.ts:613/959`, `local-runtime.ts:592`). `loadConfig` with a missing
  cwd does not throw (the gone-folder tests exit 0). **Holds.**
- *The store key is the original path.* `projectKey` falls back to `resolve(path)` when
  `realpath` fails (`session-store.ts:164-176`). The attach reads with
  `config.cwd = <original path>`, and the tests assert it. **Holds**, with the edge
  case in finding 1.
- *No other attach behaviour changed.* The `main.ts` changes since round 2 are only
  `moveTo` and its two call sites (`git diff`). The docs edits are `README.md` and
  `detached-handover.md:498`. The intended widening is that a detached run whose
  `owner.json` cwd is gone now attaches too, which matches the owner's
  "every engine" decision. **Holds.**

**Findings**

1. **LOW: the session key can change when the folder is deleted, if the stored path
   goes through a symlink.** I checked this with a probe
   (`.tentacle/tmp/attach-plain-resume-review/key.test.ts`). The key is
   `sha256(realpath)` while the folder exists and `sha256(resolve)` once it is gone.
   They differ for a logical path (the macOS `/var` → `/private/var` tmpdir, or a user
   symlink): `same key after delete: false` in both cases. A normal launch is safe:
   Bun's `process.cwd()` returns the physical path (probe:
   `/private/var/…/real/proj` after a chdir through a link), so a recorded `cwd`/`mount`
   is already a realpath. A config-file `cwd:` through a symlink would get a fresh
   session plus one note, which is not silent and not a refusal. The test at
   `main.test.ts:1881-1883` files the record under the path that is already missing
   (and logical under the macOS tmpdir). It therefore does not model "saved while the
   folder existed, then deleted". Optional fix: realpath the folder when `run` records
   `cwd`, and save then delete a realpath'd folder in the test.

**Mutation** (one, mine): `moveTo` returns `true` without reloading when the folder is
missing, so it stays silently in the launch folder. It was **killed**: 3 tests red in
`main.test.ts`. I reverted it, and `shasum -c` reports `main.ts: OK`.

**Gate** (once, foreground): root `tsc --noEmit` clean. `biome check .` reports 621
files, clean. `bun test packages` gives **4328 pass, 3 skip (opt-in), 0 fail**.

**Executor behaviour:** the round was minimal and in scope. Tests were written first
(3 red), and the round-2 LOW (test title / neither-field case) was fixed. The docs
superseded by the decision were updated, and the missing
`docs/attach-detach-behaviour.md` was stated honestly. The symlink edge (finding 1)
was not considered.
