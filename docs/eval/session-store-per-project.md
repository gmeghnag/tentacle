# eval/session-store-per-project — sessions under `~/.config/tentacle/sessions/<cwd-key>/<uid>.json`

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** M · **Blast:** load-bearing (the persisted layout and the §7 "persistence lives on the laptop/main thread" invariant) · **Suited:** a strong model executes if promoted; mandatory fresh-context Review.

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

*(empty until promoted)*

## Execution

*(empty until promoted)*

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
