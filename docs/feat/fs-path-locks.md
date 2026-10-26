# feat/fs-path-locks — Per-path locks for read-modify-write file tools

> **Status:** execution
> **Branch:** `feat/fs-path-locks`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute; standard Review

## Context

*— claude-sonnet-5-5, 2026-10-26*

Source: the parallel tools/agents eval (`parallel-eval.md`, repro D, §2.1, row 1 of
"Size, blast and proposed split"). `fs_edit` / `fs_multi_edit` read a file, transform
it and write it back, with nothing excluding a second writer in between. Two edits on
one path (two calls in a future parallel round, or two sub-agents sharing the one
workspace) lose an update **silently**: both report success and one edit vanishes.
The eval's repro D:

```
D. results: "edited f.txt (+1 -1)" | "edited f.txt (+1 -1)"
D. file now: "ALPHA\nbeta\n" (both edits reported success)
```

Agents already share the parent's `env` (`packages/agent/src/subagent.ts:182`, `env: deps.env`),
so the hazard exists across sub-agents today, even with a sequential loop. This task
fixes just that; no scheduler, no parallelism in the loop.

**Repro** (red test, run on code without the lock, 2026-10-26): two concurrent
`fs_edit`s (`alpha→ALPHA`, `beta→BETA`) on an env whose read/write yield:
`expect(files["f.txt"]).toBe("ALPHA\nBETA\n")` → received `"alpha\nBETA\n"`-class lost update (4 of 6 new tests red).

## Implementation

*— claude-sonnet-5-5, 2026-10-26*

### Load-bearing assumption

Parent and sub-agents share one `ExecutionEnvironment` object, so a lock keyed off the
env is shared with no wiring: `packages/agent/src/subagent.ts:182` (`env: deps.env`)
is the only env a child gets; the parent builds its `ToolContext` from
`this.config.env` (`packages/agent/src/agent.ts:522,619`).

### Preconditions

- Tools reach the filesystem only through `ctx.env.readFile/writeFile`
  (`packages/tools/src/builtins.ts`, fs_write/fs_edit/fs_multi_edit), so wrapping that
  sequence is the whole critical section.
- `ToolContext` (`packages/core/src/tool.ts`) is an in-process type, never serialised: no
  protocol / persisted-format change, no §7 invariant touched. In a pod all agents live
  in the one daemon, so an in-process lock covers them.
- Tool `execute` signatures return `Promise<ToolResult>`; a non-`async` function that
  returns the locked promise is compatible.

### Design

- `PathLocks` (`packages/core/src/path-locks.ts`): `withLock(path, fn)`, FIFO per path via
  a promise chain; entry deleted when the queue drains; lock released on throw. Key =
  lexical normalisation (`//`, `.`, `..`); relative vs absolute spellings are NOT unified (no cwd in
  the env contract) — documented limitation, as is `sed -i` via shell bypassing it.
  Also known limits (code comment in `path-locks.ts`): differently-cased names on a
  case-insensitive FS (`F.txt`/`f.txt`) and symlinked paths (`link/f`/`real/f`) get two locks.
- `pathLocksFor(env)`: one instance per env (`WeakMap`) — the default.
- `ToolContext.pathLocks?` optional override (tests, future wiring); tools use
  `ctx.pathLocks ?? pathLocksFor(ctx.env)`. So the agent loop needs no change.
- `fs_write`, `fs_edit`, `fs_multi_edit` hold the lock across read→write (`lockPath`).
  `fs_write` is included because its diff "before" is read and a queued write must
  see the preceding edit. With the RMW atomic, a clashing second edit fails with
  `old_string not found` instead of silently overwriting.

### Files

1. `packages/core/src/path-locks.ts` (new) · `index.ts` export · `tool.ts` field.
2. `packages/tools/src/builtins.ts` — `lockPath` + the three tools.
3. Tests: `packages/core/test/path-locks.test.ts`, `packages/tools/test/path-locks.test.ts`.

### Failure modes

- Tool throws (e.g. missing file): `finally` releases; the next waiter proceeds (tested).
- Abort/cancel: a waiter is not cancellable; it runs after the holder finishes. Holders
  are short (one read + one write), so accepted.
- Deadlock: no tool takes two locks, no re-entrancy → none.
- Different paths: independent (tested). Same file via different spellings: lexical
  forms unified, others not (limitation).
- Memory: map entry removed when the queue drains.

### Tests

- Tools: concurrent `fs_edit`s both land (repro D); clashing edit errors visibly;
  `fs_edit`/`fs_multi_edit`/`fs_write` serialise; other path not blocked; throw
  releases; a shared `ctx.pathLocks` across two contexts (parent/sub-agent) excludes.
- Core: FIFO, lexical keys, relative≠absolute, throw releases, `pathLocksFor` per env.
- Non-vacuity: mutation (drop `await previous`) → 6 of 11 red.

## Execution

*— claude-sonnet-5-5, 2026-10-26*

Done in plan order; no drift in the design. Order: baseline → `PathLocks` + `ToolContext`
field → tests written first → red → wiring in `builtins.ts` → green → mutation → gate.

- **Red** (tools test, before wiring `builtins.ts`): 4 fail / 2 pass in
  `packages/tools/test/path-locks.test.ts`, e.g. `- "ALPHA … + "alpha` on the
  concurrent-`fs_edit` test (lost update). The 2 that pass pre-fix are guards
  (other-path independence, throw releases).
- **Green:** 35 pass / 0 fail across the two new files + `builtins.test.ts`.
- **Mutation:** backup via `cp` (shasum `6f457d83…`), removed `await previous` in
  `withLock` → 6 of 11 red (4 tools, FIFO, lexical-key); restored from the backup, shasum identical.
- **Gate** (environment notes): `bun run check` as a whole cannot go green in this
  worktree: `tsc -p apps/mobile` fails (`expo/tsconfig.base` not installed, filtered out of
  the install) and, worse, emits stray `.js` files into `apps/mobile` that I deleted.
  Steps run separately: `tsc --noEmit` clean; `biome check .` clean (0/0) once the
  strays were gone; `bun test` 3129 pass / 3 skip / 1 fail. The 1 fail is
  `apps/mobile/test/rn-websocket.test.ts` (`Cannot find module '@tentacle/client'`),
  pre-existing and environmental (identical in the baseline, which also had the
  stray-`.js` duplicate: 3118 pass / 2 fail).
- Unverified: no end-to-end run with real sub-agents; covered by the shared-env
  argument (`subagent.ts:182`) and the two-context test.

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context, a different model family from the executor)

**Verdict: REQUEST-CHANGES** (small: one test). The code is correct. But the
release-on-throw property the plan marks "(tested)" is **not** pinned: a mutation
that leaks the lock on throw stays green.

**Findings**

1. **(medium, test non-vacuity, §9)** `packages/core/test/path-locks.test.ts:48` and
   `packages/tools/test/path-locks.test.ts:96`. Both "throw releases" tests run
   the thrower and the next caller **sequentially**. So after the throw, the
   `finally` deletes the map entry (`path-locks.ts:55-56`), and the next caller
   starts from a fresh `Promise.resolve()`. It never waits on the thrower's
   `release`. Mutation: call `release()` only on success (not in `finally`) →
   **11/11 still pass**. In production that mutation hangs every waiter queued
   behind a throwing `fs_edit` (e.g. `readFile` on a missing file) forever. Fix: queue a waiter *while* the thrower holds the lock
   (`Promise.all([throwing, waiter])`), then assert the waiter resolves. The
   Failure-modes line "finally releases; the next waiter proceeds (tested)" is
   false until then.
2. **(low, test gap)** `path-locks.ts:55-56`: nothing tests the map drain (memory
   growth). Deleting the `tails.delete` line is invisible to every test (no test
   observes `tails`). The logic is correct by inspection: an entry is removed
   only if no later waiter replaced the tail. Optional: expose a `size` getter
   for a test, or accept the gap.
3. **(low, documented-limitation completeness)** `path-locks.ts:6-8`. The
   comment and the plan list relative-vs-absolute aliasing and `sed -i`. They
   omit two other spellings that bypass the lock: **case** on case-insensitive
   macOS APFS (`F.txt` vs `f.txt`) and **symlinks** (`link/f` vs `real/f`). Note
   that the env *does* have a cwd internally (`host-execution.ts:212,221`
   `resolve(this.defaultCwd, path)`). It just isn't in the
   `ExecutionEnvironment` contract, so "no cwd in the env contract" is accurate.
   Lexical `..` collapse over a symlink (`link/../f`) can only *merge* two locks
   (over-serialise), never split them, so it is safe. Add the two cases to the
   comment.
4. **(nit, premise)** The cited `subagent.ts:182` is now `subagent.ts:182`
   (`env: deps.env`). The content holds.

**Gate** (re-run by me, mobile deps installed): `bun run check` is green.
`tsc --noEmit && tsc -p apps/mobile` is clean; `biome check .` reports 526 files,
no fixes; `bun test` gives **3132 pass / 3 skip / 0 fail** (3135 tests, 243
files). The 3 skips are the opt-in ones. After the gate, the tree is unchanged
(`git status` shows only the task's 7 paths, no stray `.js`).

**Mutations** (`cp` backup to `.tentacle/tmp/fs-path-locks/`; restored; `shasum`
identical: `path-locks.ts 6f457d83…`, `builtins.ts 82c3a0f2…`):
- M1 `release()` moved out of `finally` (lock leaked on throw) → **0 fail /
  11 pass. SURVIVES** → finding 1.
- M2 `fs_write` unwrapped from `lockPath` → **1 fail** (`fs_multi_edit and
  fs_write serialise…`: got `"x B C\n"` instead of `"final\n"`). Killed.
  This also shows the unlocked RMW losing a write, the repro-D class. I did not
  separately re-run the original repro on `main`.

**Premise table**

| Premise | Verdict |
|---|---|
| Lost update on concurrent RMW (repro D) | TRUE: shown by M2 (unlocked write ordering lost) |
| `subagent.ts:182` `env: deps.env` | TRUE content, stale line (now :182) |
| `agent.ts:522,619` `env: this.config.env` | TRUE |
| Parent and child get the same env object | TRUE: `cli/src/wiring.ts:385` passes the same `env` into `createSubagentRunner` |
| FS writes from tools only via `ctx.env.writeFile` in fs_write/edit/multi_edit | TRUE (`builtins.ts:125,197,244`). The only other env write is the spill `agent.ts:1366`, a per-call-unique path, so it has no RMW hazard |
| `ToolContext` is in-process, never serialised | TRUE: optional field, no protocol/persisted-format/§7 change |

**Attacks tried**
- *Scope creep / §7:* the diff touches only `core/path-locks.ts` (new), a `core`
  export, one optional `ToolContext` field, and three tool bodies. There is no
  protocol, persistence, agent-loop or RPC-peer change. Holds.
- *Deadlock:* no tool takes two paths. `withLock` is not re-entrant, but no
  caller nests it (a tool never calls another tool). A sub-agent runs its tools
  in its own `execute` calls, never inside a held lock. No deadlock found.
- *Chain poisoning:* `tail = previous.then(() => mine)`. `mine` only resolves,
  so a thrower never rejects the chain, and its error goes only to its own
  caller. Holds.
- *Key aliasing:* `a//b`, `a/./b` and `a/y/../b` unify (tested). Relative vs
  absolute, case and symlinks do not (finding 3). This is a residual
  silent-lost-update path, accepted as a limitation.
- *Abort:* a waiter ignores `ctx.signal`. A holder stuck on a hung remote
  `writeFile` blocks queued edits on that path past a user abort. This was
  already uncancellable before (the fs tools never took the signal), and the
  plan accepts it. Low.
- *Read-only tools:* `fs_read` and others are untouched. Holds.
- *Cross-session:* each session builds its own wiring/env, so two `serve`
  sessions on one workspace do not share locks. That is out of this row's scope
  (sub-agents). Worth a line in the eval's later rows.

**What holds:** the lock logic (FIFO, release, drain), the per-env `WeakMap`
default, the wiring of all three RMW tools, and the "clashing edit errors
visibly" behaviour (fail-loud instead of silent overwrite). M2 shows the
serialisation test is real.

**Executor behaviour:** a tight, honest S task. The plan was source-cited and
the scope exact. It reported the environment-blocked gate truthfully instead of
claiming green. It showed red before green and ran a mutation, but its mutation
(`await previous` dropped) did not cover the release-on-throw property it
claimed as tested. That is the one overclaim.

### Execution — review fixes

*— claude-sonnet-5-5, 2026-10-26*

1. **Release on throw (medium).** Both "throw releases" tests now queue a second acquirer WHILE the first throws (`packages/core/test/path-locks.test.ts`, `packages/tools/test/path-locks.test.ts`; the second must resolve, raced against a 200 ms "hung"). Mutation M1 (`release()` only on success, via `cp` backup `path-locks.good`): 2 red (one per file), 11 pass. Restored, shasum identical (`fe7757e6…`).
2. **Map cleanup (low).** Added a `size` getter on `PathLocks` (documented "for tests") and a test: size 2 while two paths are queued, 0 once drained. Mutation M2 (`tails.delete` removed): 1 red (the drain test). Restored, shasum identical.
3. **Aliasing limits (low).** Case-insensitive FS and symlinks added to the comment in `path-locks.ts` and to the Design section.
4. **Stale ref (nit).** `subagent.ts:169` → `:182` in this doc (history in the Review text updated too).

Red-first note: these are new tests of already-correct code, so "red" is shown by the mutations above (the pre-review suite stayed green under M1, per the Review). Gate: `bun run check` green — typecheck, biome 526 files clean, `bun test` 3134 pass / 3 skip / 0 fail.

> **Owner (2026-10-26):** merge approved; review nits carried as debt.
