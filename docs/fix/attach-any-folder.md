# fix/attach-any-folder — `attach` works from any folder

> **Status:** execution done, review pending
> **Branch:** `fix/attach-any-folder`
> **Type:** fix · **Size:** S · **Blast:** cross-module · **Suited:** a stronger model + fresh-context Review (touches the sessions filing and the attach path of `main.ts`)

## Context

*— claude-sonnet-5-5, 2026-11-04*

Owner, live 2026-11-04:

```
$ tentacle attach tentacle-735a7728

[error] tentacle-735a7728: this detached run belongs to /Users/gmeghnag/trash: run `tentacle attach tentacle-735a7728` from there
```

Decision: `attach` works from ANY folder. It behaves as if launched from the
workload's own folder (the laptop session copy is filed under
`sessions/<cwd-key>/` of THAT folder; `--resume`/`--continue` look there;
everything else `attach` derives from the cwd too). Only if that folder no
longer exists: one line. Also: no blank line before `[error]`, for every error.

Cause of the refusal: `planAttach` returned `refuse/why:"cwd"` when
`owner.cwd !== input.cwd` (`attach-plan.ts`, removed), worded at `main.ts`
`attachRefusal`. Cause of the blank line: the literal `"\n[error] …"` at every
call site (main.ts ×12, attach-run.ts ×6, repl.ts ×1).

**Repro** (2026-11-04, current `main`): the new tests, run before any source
change — 8 red (`bun test packages/cli/test/main.test.ts packages/cli/test/attach-plan.test.ts`:
92 pass / 8 fail), e.g. a run of folder X attached from Y → exit 1 with
`this detached run belongs to …`, and `attach` with no name printing
`\n[error] …`.

## Implementation

*— claude-sonnet-5-5, 2026-11-04*

### Load-bearing assumption

The folder we move to is written by the LAPTOP, never supplied by a pod
(AGENTS §7 "a pod is not trusted"). Proven, both sources:

- **Detached run, `owner.json` `cwd`.** Written only by (a) the relay,
  `relay.ts:207-217` (`cwd: spec.cwd`), a laptop process; `spec.cwd` comes from
  the laptop launcher, `main.ts:1038` (`cwd: config.cwd`) → `writeSpec`
  (`run-state.ts:330`) → read back at `relay.ts:605`; (b) a laptop TUI that
  joined the run, `attach-run.ts:430` (`cwd: deps.owner.cwd ?? deps.cwd`) —
  it re-writes the value it read. Both go through `writeOwner`
  (`run-state.ts:154`, `writeAtomic`, mode 0600) into
  `<configDir>/kept/runs/<stem>/` (`run-state.ts` `runDirFor`), the laptop's
  config dir. Nothing in a pod's reach writes there: pod → laptop effects are
  RPC requests gated on the laptop (§7), and none writes `owner.json`.
  `readOwner` (`run-state.ts:~195-210`) only parses the file.
- **Plain kept container, `KeptEntry.mount`.** Written by `run` on the laptop,
  `main.ts:964` (`mount: wsPlan.mount.target`; target == the launch cwd, the
  "same path" mount, `workspace-mount.ts:~633-700`), persisted by `recordKept`
  (`kept-index.ts:50`, `<configDir>/kept`, 0600). Same trust rule as the kept
  index's own `kept.ts:7-10` ("WHERE to dial comes from the index, never from a
  label").
- **NOT used: the container's workspace label** (`state.workspace`,
  `engine-runtime.ts:728`): forgeable by anyone with the container (its own
  comment says so). It stays what it was — only input to `attachCwdWarning`.

So no source is pod-supplied; nothing to stop on.

### Preconditions

- `config` in `main.ts` is a `let`, already reassigned once for the run's model
  (`useRunModel`, `loadConfig({cwd, scaffold:false, profile})`); everything the
  attach derives from the cwd reads `config.cwd` at call time:
  `openSessions` (`main.ts:~750`, sessions root `config.configDir/sessions`,
  `cwd: config.cwd`), `joinRun` (`cwd`, `openSessions`, `readRecord`),
  `attachEngineRuntime(config, …)`. So reloading `config` for the folder moves
  all of it at once. `configDir` is not cwd-dependent (`load.ts`, `options.configDir`/home).
- A plain `attach` whose run record is not this workload's
  (`created` mismatch), `--resume <other uid>`, or no owner record yields
  `plain` — no folder known from a record; unchanged.

### Design

- `attach-plan.ts`: drop the `cwd` input and the `refuse/"cwd"` plan; the
  `run` plan carries `cwd?` = the record's folder.
- `main.ts` (attach): `moveTo(folder, what)` — `undefined`/same folder: no-op;
  not a directory: `[error] <name>: the folder of this <run|container> no
  longer exists: <folder>` (one line, `untrustedText`), exit 1, nothing
  dialled; else `config = loadConfig({cwd: folder, scaffold:false, profile,
  model flag})`. Called on a `run` plan (before `useRunModel`, which now loads
  from `config.cwd` instead of `process.cwd()`), and for a plain kept container
  from `keptEntry.mount`. The `plan` is now computed before `useRunModel`
  (it needs neither).
- **Plain container with no recorded folder** (no `mount`: a remote engine
  mounts nothing, `--no-mount`; or explicit engine flags, which skip the kept
  index): no folder is known anywhere (labels are not trusted), so it keeps
  today's behaviour — the launch folder, with `attachCwdWarning` if the
  container's own label says otherwise.
- Blank line: remove the leading `\n` of every `[error]` literal. (Other
  prefixes, `[config error]` etc., are out of scope.)

### Files

`packages/cli/src/attach-plan.ts`, `packages/cli/src/main.ts`,
`packages/cli/src/attach-run.ts`, `packages/cli/src/repl.ts`; tests
`packages/cli/test/attach-plan.test.ts`, `packages/cli/test/main.test.ts`;
docs `README.md:184`, `docs/feat/detached-handover.md:498`.

### Failure modes

- Folder gone (run or container): one line, exit 1, nothing dialled.
- Folder's project config invalid: `[config error] …`, exit 1.
- Record without `cwd` (old): no move (as before the check existed).
- `--resume <uid>` of another session on a detached run: `plain`, the kept entry's mount folder (none: the launch folder), with the run's model.
- A forged label: never read for the folder.
- `--profile`/`--model` flags still win in the reloaded config.

### Tests

`attach-plan.test.ts`: the plan carries `cwd`, no refusal on folder.
`main.test.ts`: (1) a run of folder X attaches from elsewhere with
`config.cwd === X`; (2) folder gone → exact one-line error, no runtime;
(3) plain container: `--continue` looks in `sessions/<mount>` ("no saved
sessions for <mount>"), no mount → launch folder, mount gone → one line;
(4) the `[error]` line starts at column 0.

## Execution

*— claude-sonnet-5-5, 2026-11-04*

1. Tests first; red on `main`: 92 pass / 8 fail (4 plan tests, 4 main tests).
2. `attach-plan.ts`, `main.ts` per Design; `\n[error]` → `[error]` in
   `main.ts`, `attach-run.ts`, `repl.ts` (`rg '\\n\[error\]'` → none left).
3. Drift: the plain-container test cannot use `attachEngineRuntime` as a seam
   (the plain path calls the real one; the existing "nothing dialled" tests
   rely on that), so it observes the folder through `--continue`'s
   `[resume] no saved sessions for <folder>` line — which is also the sessions
   filing itself. The `attached` fake runtime gained `dispose`.
4. Mutations, one each, reverted (`shasum -c` OK on `main.ts`, `attach-plan.ts`):
   | # | Mutation | Red |
   |---|---|---|
   | M1 | plan drops `cwd` | 2 plan + 2 main tests |
   | M2 | no existence check (`there = true`) | gone-run + plain tests |
   | M3 | plain ignores `mount` | plain test |
   | M4 | `\n` back before `[error]` (`result.error`) | column-0 test |
   | M5 | `loadConfig` result not assigned | run + plain tests |
   (A first mutation round was applied without backups and reverted by hand;
   the redo above is the clean one.)
5. Docs: README:184, `detached-handover.md:498`.
6. Gate: see the final report (`bunx tsc --noEmit`, `bunx biome check .`,
   `bun test packages`).

Unverified: a real terminal run (`tentacle attach` of a live detached run from
another folder) — needs the owner's environment.

## Review

**Verdict: REQUEST-CHANGES** (two MEDIUM, both small fixes).

**Findings**

1. **MEDIUM — the `[error]` after streamed text now sticks to it.**
   `repl.ts:56` and the one-shot catch `main.ts:1581` follow `render(event)`,
   which returns a `text` delta as it is, with no newline (`render.ts:11-12`).
   The removed `\n` was what put the error on its own line. If a provider fails
   mid-answer you now get `Hello wor[error] Error: ECONNRESET`. Every other
   site prints before any output, so dropping the `\n` is right there. Fix:
   in these two stream paths, write `\n` only when the last character written
   was not a newline (track it in `write`); add a test with a partial `text`
   event followed by a throw. Unverified: my repro
   `.tentacle/tmp/attach-any-folder-review/repl.ts` was not allowed to run in
   this session. The finding comes from reading the code.
2. **MEDIUM — the run's model is lost on the `plain` fallthrough of a
   detached run from another folder.** In the run loop, `useRunModel(run.entry)`
   runs (`main.ts:1301`), then `plan.kind === "plain"` breaks. Then
   `moveTo(keptEntry.mount)` (`main.ts:1386`) reloads `config` with only
   `config.profile` and `modelFlag`, which drops the `{ ...loaded, model:
   plan.model }` override. `useRunModel(keptEntry)` then returns early, because
   `runModelOf === entry.created` (same entry). Trigger: a mounted detached run
   attached from another folder with `--resume <other uid>` (no live relay), or
   a record whose `created` does not match. The status bar shows the profile's
   model, not the run's. Fix: call `moveTo` before any `useRunModel` (do the
   plain-path move inside the loop, or reset `runModelOf` in `moveTo`). Add a
   test for it. The Failure-modes line "`--resume <uid>` of another session:
   `plain`, launch folder" is also wrong: it is now the mount folder.
3. LOW — `moveTo`'s `[config error]` has no `\n` in front, but `useRunModel`'s
   (`main.ts:1213`) and the pre-config one (`main.ts:520`) still do. That is out
   of scope by the plan, but `attach` is now inconsistent.

**Gate** (one run, foreground). `bunx tsc --noEmit`: OK. `biome check .`: clean,
617 files. `bun test`: 4308 pass / 3 skip (opt-in) / 2 fail + 2 errors, all
in `apps/mobile/test/rn-websocket.test.{ts,js}` (`Cannot find module
'@tentacle/client'`). That is the environment: `apps/mobile` is not installed
in this worktree. `bun run check` itself stops at `tsc -p apps/mobile`
(`expo/tsconfig.base` not found). That run **emitted 6 `.js` files** into
`apps/mobile` (the `.test.js` is the second fail). I removed those 6 untracked
artifacts; the tree is back to the executor's state. Narrow run:
`main.test.ts` + `attach-plan.test.ts` 100 pass / 0 fail.

**Mutation (mine).** `moveTo` loads `cwd: config.cwd` instead of `folder`
(`main.ts:1243`). Red: 2 tests (run-from-any-folder and plain-container-by-mount).
Reverted, `shasum -c` OK, 100/100 green again.

**Premise table**

| Premise | Verdict |
|---|---|
| Symptom: the `refuse/"cwd"` plan in `attach-plan.ts` | TRUE (removed in the diff) |
| `owner.json` written only by `relay.ts:207` (`spec.cwd` from the laptop) and `attach-run.ts:438` (re-writes what it read, or `deps.cwd`, now `config.cwd`) | TRUE: `rg writeOwner(` finds only these two |
| `KeptEntry.mount` = `wsPlan.mount.target` = the launch cwd (`main.ts:965`, `workspace-mount.ts:632`) | TRUE |
| The workspace label is not used for the folder | TRUE: `moveTo` reads only `plan.cwd` and `keptEntry.mount` |
| `configDir` does not depend on cwd (`load.ts:420`) | TRUE, so the kept index and run dirs are unchanged after the move |
| `joinRun`, `openSessions` and `readRecord` read `config.cwd` at call time | TRUE (`main.ts:1316-1334`), so the copy is filed under `sessions/<run folder>` |

**Attacks tried**

- Pod-supplied folder (§7): traced every writer, none is in the pod's reach.
  Holds.
- Folder gone: one line, exit 1, before any dial. Holds (test plus M2).
- Reused name, `created` mismatch: `plain`. That hits finding 2.
- Plain kept container with no mount, or explicit flags: no move, launch
  folder, `attachCwdWarning` as before. Holds.
- Attach from the right folder: `folder === config.cwd` returns early, nothing
  reloaded. Identical.
- `--profile`/`--model` after the move: both are passed to `loadConfig`.
  Holds. The run's model does not survive on the plain path (finding 2).
- Blank line: no `\n[error]` is left in `packages/*/src`. Breaks the stream
  paths (finding 1).

**Executor's behaviour.** Tests were written first and shown red. The trust
trace in the plan is accurate and cited. Five mutations were recorded honestly,
including the first sloppy round. It missed the ordering between `useRunModel`
and `moveTo` on the plain path, and the two stream sites where the `\n` did
real work.

Same model family as the executor (Claude), but a fresh context: shared blind
spots are possible.

*— claude-opus-5-5, 2026-11-04*

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

1. **Finding 1 (stream `[error]`).** `render.ts`: `atLineStartAfter` +
   `errorLine(error, atLineStart)`. `repl.ts` (per turn, starts true) and the
   one-shot loop in `main.ts` track the last chunk; `\n` is written before
   `[error]` only when the cursor is not at a line start. Tests (`repl.test.ts`):
   partial `text` then a throw -> `Hello wor\n[error] `; a throw with nothing
   written -> no blank line. Red first on the round-1 code: `Hello wor[error] …`.
2. **Finding 2 (plain loses the run's model).** `moveTo` now sets
   `runModelOf = null` after its reload, so `useRunModel` re-applies the run's
   model. Test (`main.test.ts`, "plain fallthrough"): dead run, `--resume` of
   another uid -> `plain`; profile `deep` now says `deep-newer`, the run says
   `deep-chat`; the plain runtime must get `deep-chat` in the mount folder.
   First draft (profile model unchanged) was green on the bug — the reload kept
   `config.profile`; made the model differ, then red: `deep-newer`.
   Seam: `attachPlainRuntime` (io), used only by the plain `attach` call; the
   `attached` helper takes `plainSeam` (default off, so "nothing dialled" tests
   are untouched).
3. **LOW 3:** `useRunModel`'s `[config error]` lost its leading `\n`
   (`main.ts:1215`). Not done: the pre-config `[config error]` (`main.ts:522`)
   is shared by every command — out of scope, still has `\n`.
   Failure-modes line 113 corrected (mount folder, with the run's model).
4. **Mutations (one each, reverted; `shasum` of `main.ts`/`render.ts` identical
   to the backup):** M6 `errorLine` without the lead `\n` -> the streamed-text
   test red; M7 drop `runModelOf = null` -> the plain-model test red.
5. **Gate (once, foreground):** `bunx tsc --noEmit` clean; `bunx biome check .`
   clean (617 files); `bun test packages` 4272 pass / 3 skip (opt-in) / 0 fail.

Unpinned: the one-shot catch in `main.ts` shares `errorLine`/`atLineStartAfter`
with the REPL but has no end-to-end test (needs a provider that fails mid-stream).

## Review — round 2

**Verdict: PASS (APPROVE-WITH-NITS)** — both round-1 MEDIUMs fixed and pinned; LOW only.

**Round-1 findings**
1. *Stream `[error]` glued* — FIXED. `render.ts` `atLineStartAfter`/`errorLine`;
   `repl.ts:51-59` and the one-shot loop `main.ts:1579-1588` track the line start
   and write `\n` only mid-line. Pinned by `repl.test.ts` (partial text → own
   line; nothing written → no blank line).
2. *Plain fallthrough loses the run's model* — FIXED. `moveTo` resets
   `runModelOf = null` after the reload (`main.ts:1255`), so
   `useRunModel(keptEntry)` re-applies the run's model; the run path (move
   before `useRunModel`) is unaffected. Pinned by the `main.test.ts` "plain
   fallthrough" test (profile model ≠ run model; executor's M7 red).
3. *LOW `[config error]` lead `\n` in attach* — fixed for `useRunModel`.

**Remaining LOW**
- L1: the one-shot catch (`main.ts:1588`) has no end-to-end test; it shares the
  unit-tested helpers with the REPL. Accepted.
- L2: the pre-config `[config error]` (`main.ts:522`) still has a leading `\n`
  (shared by every command; out of scope).

**Regression check.** `rg '\\n\[error\]' packages/*/src` → none: the blank line
before `[error]` stays gone on all CLI paths; only the stream paths add `\n`,
and only mid-line.

**Gate** (once, foreground; `bun run check` not used — in this worktree its
`tsc -p apps/mobile` emits `.js`, round 1): `bunx tsc --noEmit` OK; `biome check .`
clean (617 files); `bun test packages` 4272 pass / 3 skip (opt-in) / 0 fail.
Narrow: `repl` + `main` + `attach-plan` 106 pass / 0 fail. Tree: no new
untracked files.

**Mutation (mine).** `repl.ts:55` no longer updates `atLineStart` → red: "an error
after streamed text starts on its own line". Reverted; `shasum -c` OK; green.

Same model family as the executor, fresh context.

*— claude-opus-5-5, 2026-11-04*
