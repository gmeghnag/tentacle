# fix/session-store-per-project — sessions under `~/.config/tentacle/sessions/<cwd-key>/<uid>.json`

> **Status:** done — merged to `main` 2026-10-20 (`2f3fce4`; in-context review, fresh Review waived by the owner; promoted from `docs/eval/` by the owner, 2026-10-20) · status synced by audit 2026-10-20
> **Branch:** `fix/session-store-per-project`
> **Type:** fix · **Size:** M · **Blast:** load-bearing (the persisted layout and the §7 "persistence lives on the laptop/main thread" invariant) · **Suited:** strong model executes; fresh-context Review mandatory by §10 — **waived by the owner** for this task (2026-10-20, "attenzione alta senza review")

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** should the session store move from one flat
directory to one directory per project,
`<configDir>/sessions/<cwd-key>/<uid>.json`? If so: how is `<cwd-key>` derived,
what happens to `--resume <uid>`, and how are the existing flat files migrated?

The owner chose this layout over `${PWD}/.tentacle/sessions` on 2026-10-17. The
reasons:
- it keeps sessions out of every project tree, so there is no git or secret
  risk;
- it works outside a repo and for `run`/`attach`;
- it survives `git clean` and re-clones;
- it still makes `--resume` per-project.

### Code under examination

- `packages/agent/src/session-store.ts:55-109` — `JsonSessionStore(dir)`:
  - one flat `dir` of `<uid>.json`;
  - `list()` reads every file and sorts by `updatedAt`;
  - `latest()` is `list()[0]`, and nothing filters by project.
- `session-store.ts:16` — every record already stores `cwd`, so the information
  exists but is unused for selection.
- `packages/cli/src/main.ts:269` (pod `run`/`attach`) and `:452` (local TUI)
  call `new JsonSessionStore(join(config.configDir, "sessions"))`.
  `--resume` without a uid calls `store.latest()` (`:274`, `:456`).
- The recorded `cwd` is `config.cwd` (`main.ts:302,484,518,529`,
  `pod-runtime.ts:287,470`, `local-runtime.ts:121`). It is
  `pick(env.TENTACLE_CWD, fileConfig.cwd, defaultCwd)`
  (`config/src/resolve.ts:186`) and is **not normalized**: it can be relative,
  have a trailing slash, or be a symlink.
- For `run`/`attach`, the recorded `cwd` is the **laptop** `config.cwd`, not the
  pod's workspace. `connect` does not persist sessions
  (`cli/src/connect.ts:15-33`, no store), so it is out of scope.

### Repro

*Run 2026-10-17 in `.tentacle/tmp/session-store-per-project/` (AGENTS §6).*

```ts
// repro.ts — `--resume` (no uid) = store.latest() ignores the launch cwd.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord } from "@tentacle/agent";

const dir = await mkdtemp(join(tmpdir(), "sessions-"));
const store = new JsonSessionStore(dir); // = join(config.configDir, "sessions"), main.ts:269/452
const rec = (id: string, cwd: string, updatedAt: number): SessionRecord => ({
  id, cwd, model: "m", createdAt: updatedAt, updatedAt, title: `work in ${cwd}`,
  messages: [{ role: "user", content: `work in ${cwd}` }],
});
await store.save(rec("aaaa", "/work/projB", 1000)); // older session, in projB
await store.save(rec("bbbb", "/work/projA", 2000)); // newer session, in projA
const picked = await store.latest();               // user is in /work/projB, runs --resume
console.log("launched in:     /work/projB");
console.log("resumed session:", picked?.id, "cwd =", picked?.cwd);
console.log("files on disk:  ", (await readdir(dir)).join(", "));
```
```
launched in:     /work/projB
resumed session: bbbb cwd = /work/projA
files on disk:   aaaa.json, bbbb.json
```

`tentacle --resume` launched in project B resumes project A's conversation. The
daemon is then confined to B's cwd, so the model continues A's task against B's
files.

```ts
// encode.ts — the naive Claude-Code-style key collides, and cwd needs realpath.
import { realpathSync } from "node:fs";
const naive = (p: string) => p.replace(/[/.]/g, "-");
console.log(naive("/work/a-b"), "==", naive("/work/a/b"), "→ collision:", naive("/work/a-b") === naive("/work/a/b"));
console.log("/tmp realpath →", realpathSync("/tmp"));
```
```
-work-a-b == -work-a-b → collision: true
/tmp realpath → /private/tmp
```

### Prior art (constraints)

- `docs/fix/session-store-durability.md`: same file. `save` is not atomic,
  `load` swallows parse errors as "absent", and saves are fire-and-forget. A
  migration that moves files must not make this worse. Ideally it lands after,
  or together with, the atomic-save fix.
- `TODO.md` Block 8: "A failed session save crashes the TUI". A new `mkdir` of
  the project directory adds one more failure point on that same path.

## Implementation

*— claude-opus-5-5, 2026-10-20*

**Re-verified on `main` (`41c84d9`), 2026-10-20**, at the seam all three TUI
paths use (`openTuiSessions`; `.tentacle/tmp/session-store-per-project/repro.ts`):

```ts
const root = join(base, "sessions"); // = join(config.configDir, "sessions"), main.ts:328
const flat = new JsonSessionStore(root);
await flat.save(rec("aaaa", projB, 1000)); // older, in B
await flat.save(rec("bbbb", projA, 2000)); // newer, in A
const sessions = await openTuiSessions(root, { wanted: true }, (l) => out.push(l));
```
```
launched in: projB
resumed:     bbbb from projA
on disk:     aaaa.json, bbbb.json
```

### Load-bearing assumption

**Every client-side session read or write goes through ONE store built in ONE
place**, so re-rooting that store per project changes the behaviour
everywhere at once. Proven:
- the only client construction is `openTuiSessions`
  (`packages/cli/src/tui-sessions.ts:39`), called only by `main.ts:328`
  (`openSessions`);
- `openSessions` is shared by the local TUI, `run` and `attach`;
- the saver writes through that same store (`tui-sessions.ts:41`);
- the `serve` daemon already has its own per-project dir
  (`serve.ts:68-70`, `<configDir>/daemon/<projectKey>`) and never reads
  `<configDir>/sessions`;
- `connect` persists nothing.

The eval's "two construction sites" (`main.ts:269,452`) have since been
unified.

### Preconditions

- `projectKey(cwd)` already exists (`packages/agent/src/session-store.ts:107-122`):
  `<basename>-<sha256(realpath)[:12]>`, falling back to `resolve(cwd)` for a
  deleted cwd, and `serve` uses it. This is the eval's point 1, already built.
- Every record stores its `cwd` (`session-store.ts:23`). The recorded value is
  `config.cwd`, absolute (`load.ts`, `resolvePath(expandTilde(...))`).
- `JsonSessionStore.list()` validates every `*.json`, reports unreadable ones,
  and sweeps crashed temps (`session-store.ts:437-461`). `save` creates its
  directory (`writeAtomic`).
- `rename` is atomic within one filesystem: the root and its sub-directories
  are on the same one.

### Design

Layout: `<configDir>/sessions/<projectKey(config.cwd)>/<uid>.json`.
`JsonSessionStore` stays a dumb directory store. The project logic lives in one
new CLI module.

**Owner decision (2026-10-20): no migration.** Pre-v0.1.0 there is no
backward compatibility to keep: files of the old flat layout
(`<root>/<uid>.json`) are **ignored**. They are not resumed, not found by uid,
and not moved. This replaces the eval's point 5.

1. **`session-projects.ts` (new):** `findInOtherProjects(root, key, uid)`
   runs `load(uid)` in every project directory except `key`. It returns the
   newest valid copy, or an unreadable one, or none. Flat files at the root are
   not searched.
2. **`resolveResume`**
   - **No uid:** the project store's newest. With none, the message is
     `no saved sessions for <cwd> yet; starting fresh`.
   - **Explicit uid, not in this project:**
     - found elsewhere, with `projectKey(record.cwd) === key` (a copy filed
       under another key by hand): resume it;
     - found in **another** project: **fatal**,
       `session <uid> belongs to <cwd>; run tentacle there to resume it`;
     - unreadable elsewhere: the existing unreadable-fatal;
     - nowhere: the existing "starting fresh".

     **Drift from the eval (point 3)**, which proposed resuming with a
     notice. Refused instead: resuming A's conversation in B is the defect
     itself, and the saver would write a second copy of the uid under B.
3. **`openTuiSessions({ root, cwd }, resume, write)`** opens
   `JsonSessionStore(join(root, projectKey(cwd)))` for both resume and the
   saver.
4. **`main.ts`**: pass `config.cwd`. Help: "latest **in this folder** if no uid".

### Files

1. `packages/cli/src/session-projects.ts` (new).
2. `packages/cli/src/session-resume.ts`.
3. `packages/cli/src/tui-sessions.ts`.
4. `packages/cli/src/main.ts`.
5. Tests:
   - `packages/cli/test/session-projects.test.ts` (new);
   - `tui-sessions.test.ts` and `session-resume.test.ts` (adapted).
6. Docs: this file, `TODO.md`.

### Failure modes

| Case | Outcome |
|---|---|
| A relative, trailing-slash or symlinked cwd | One key (`projectKey` realpaths). Test. |
| Deleted cwd | `resolve(cwd)` key; its sessions are still listed under it. |
| Old flat files at the root | Ignored: never resumed or found by uid, never moved (owner decision). Test. |
| Another project's session | Never resumed by `--resume`; by uid it is refused, naming its cwd. Test. |
| Same uid in two project dirs (manual copy) | The lookup takes the newest; it only feeds the refusal message. |
| `mkdir` of the project dir fails on the first save | The saver's write errors are already non-fatal and reported (`SessionSaver`). |

### Tests

Red first.
- `session-projects.test.ts`:
  - `findInOtherProjects`: other projects only, never its own and never a flat
    file; the newest wins; unreadable; missing root.
  - At the seam (`openTuiSessions`):
    - the repro (launched in B, B's session resumes, not A's newer one);
    - a symlink or trailing slash is the same project;
    - flat files are ignored;
    - "no sessions for <cwd>";
    - another project's uid is refused;
    - this project's uid resumes;
    - the saver writes into the project dir.
- `tui-sessions.test.ts`: adapted to the new signature, with records saved
  into the project dir.

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Repro re-run on `main` (Implementation): B resumed A's newer session.
2. The eval was promoted with `git mv` into `docs/fix/` on `fix/session-store-per-project`.
3. Tests first: `session-projects.test.ts` was red (module missing).
4. Built:
   - `session-projects.ts`;
   - `resolveResume(store, uid, scope?)` (scope optional, so the unscoped tests
     hold) with a `fatal()` helper;
   - `openTuiSessions({root, cwd}, …)`;
   - `main.ts` passes `config.cwd`, and the help says "this folder".

   Drift from the eval:
   - point 3: a uid of another project is refused, not resumed;
   - point 5: the first version built the migration (64/64 of the owner's real
     sessions moved, on a copy). **The owner then decided against it**
     (pre-v0.1.0, no backward compatibility). It was removed, and flat files
     are ignored.
5. `tui-sessions.test.ts`: the new signature, with records saved into
   `join(d, projectKey("/w"))`.
6. Mutations, each reverted:
   - **M1** store at the root → 9 red.
   - **M2** resume another project's uid → 1 red.
   - **M3** flat files searched by uid → 2 red.
   - **M4** own project searched as "elsewhere" → 1 red.
7. Gate: `bun run check` → tsc clean, Biome clean, **1255 pass, 2 skip
   (opt-in), 0 fail**.
8. Repro after the fix (sessions saved in the per-project layout):

```
launched in: projB
resumed:     aaaa from projB
on disk:     projA-880407697ca2, projB-f894e0645c12
pre-mount:   ["[resume] aaaa — work in projB\n"]
```

## Review

*— claude-opus-5-5, 2026-10-17 (author of the Context; same model)*

**Verdict: PROMOTE → `fix/session-store-per-project`** (the cross-project
`--resume` is a defect, proven above). The recommended design follows; the
Implementation must still verify it against the code.

1. **`<cwd-key>` = `<basename>-<sha256(realpath(cwd))[:12]>`**, e.g.
   `tentacle-3f9a1c2e7b04`. The basename keeps it readable. The hash avoids the
   naive collision shown above and keeps the name well under `NAME_MAX` (255),
   which a full percent-encoded path can exceed. Normalize with
   `realpath(resolve(cwd))`; on failure (the cwd was deleted), fall back to
   `resolve(cwd)`. The record's `cwd` field stays the source of truth; the
   directory name is only an index.
2. **Key on the exact `config.cwd`**, not the git root. This matches what is
   recorded and what Claude Code does. A sub-directory being a separate project
   is a documented choice, not a bug. Revisit only if it bites.
3. **`--resume <uid>`** looks in the current project directory first, then
   scans all project directories (a uid is a global UUID). When it finds the
   session elsewhere, it prints `[resume] session <uid> is from <cwd>`. It
   must not silently re-home it.
4. **`--resume` without a uid** returns the newest session in the current
   project only. With none, it prints the existing "no saved sessions yet"
   message (`main.ts:279`), naming the project.
5. **Migration:** a one-shot, idempotent move at store construction. Each
   flat `sessions/<uid>.json` goes to `sessions/<key(record.cwd)>/<uid>.json`
   via `rename`, which is atomic on the same filesystem.
   - An unreadable file stays where it is and gets one warning. It is never
     deleted.
   - A crash mid-migration is safe: the next start finishes the job.
6. **Where the key is computed:** in the CLI, at the two construction sites
   (`main.ts:269,452`), using `config.cwd`. `JsonSessionStore` stays a dumb
   directory store, plus a static cross-project `find(uid)` for point 3.
   Keep this in one helper, so `run`, `attach` and the local TUI cannot drift.

**Failure modes the Implementation must cover:**
- relative, trailing-slash or symlinked `TENTACLE_CWD` must give one key;
- a deleted cwd;
- a uid that exists in two directories after a bad manual copy: prefer the
  newest `updatedAt` and warn;
- a migration with a mix of valid and corrupt files;
- `mkdir` failure on the first save (see prior art: it must not crash the TUI).

**Not verified:** behaviour on Windows paths. The repo targets macOS/Linux; the
binary build has no Windows target.


### Review of the fix

*— claude-opus-5-5, 2026-10-20*

**Fresh-context Review waived by the owner** for this load-bearing task. That
is a recorded exception to AGENTS §10, not a pass. In-context adversarial
checks:

- **No data is touched:** with no migration, nothing existing is moved or
  deleted. The old flat files simply stop being offered.
- **§7 persistence invariant:** still the main thread's own store, now one
  directory per project. The saver and the resume use the same store, which M1
  pins. The `serve` daemon's store (`<configDir>/daemon/<key>`) is untouched.
- **Behaviour change to tell users:**
  - `--resume` (no uid) only offers this folder's sessions.
  - `--resume <uid>` from another folder refuses, naming the folder.
  - Sessions saved before this change are no longer resumable unless moved by
    hand into `<root>/<projectKey(cwd)>/`.
- **Follow-up (owner request, 2026-10-20):** a picker to choose among this
  folder's sessions when `--resume` has no uid and there is more than one
  (`TODO.md`).
