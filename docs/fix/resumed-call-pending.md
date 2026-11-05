# fix/resumed-call-pending — A resumed call allowed without an ask runs with its pending entry on disk

> **Status:** execution (awaiting Review)
> **Branch:** `fix/resumed-call-pending`
> Type: fix · **Size:** S · **Blast:** load-bearing · **Suited:** strong model executes; fresh-context Review mandatory (AGENTS §10)

## Context

*— claude-opus-5-5, 2026-11-04*

Task-5 Review finding **F3** (`docs/feat/round-groups-persistence.md:676`,
`:740`, `:856`). It was already on `main` before task 5. Owner, 2026-11-04: a
separate fix (`TODO.md`, "a resumed call authorized without an ask runs with
its pending entry on disk").

The §7 persistence invariant says "pending on disk ⇒ never started". On
reload, a turn suspended on its own call's permission is resumed
(`resumableTurn`, `packages/daemon/src/persisted-session.ts:595`). The record's
pending entries are kept in memory as `carried`
(`packages/daemon/src/hosted-session.ts:472`) until one of these:
- the call is asked again (`:576`);
- any ask settles (F1's fix, `:600`);
- a commit or a context reset (`:1380`, `:1391`).

The gate can also allow the resumed call **without an ask**
(`packages/agent/src/permission-gate.ts:156-164`): a hook `force: "allow"`, a
tool whose permission became `none` across the restart, or a session rule. In
that case none of the clears above runs. The call executes while the disk still
says "resume from this call". If the daemon crashes during that run, the
reload resumes the turn and runs the call **a second time**. F1's fix does not
help, because no ask settles.

**Repro** (2026-11-04, on the branch before any source edit). The red test
T10 (`packages/daemon/test/persistence.test.ts`) takes the record that was on
disk while c1 ran and reloads it:

```
$ bun test packages/daemon/test/persistence.test.ts -t "T10"
3446 |     expect(reconcileOnReload(crashed).resume).toBeUndefined();
error: expect(received).toBeUndefined()
Received: {
  turnId: "T1",
  from: "c1",
  ...
  pending: [ { toolCallId: "c1", tool: "run", resumable: true, requestedAt: 1 } ],
(fail) T10 (F3) a resumed call allowed without an ask: ...
3485 |     expect(seen).toEqual([undefined, undefined]);
-   undefined,
+   "c1",
(fail) T10b (F3) a resumed group allowed without asks: ...
3511 |     expect(runs).toEqual([]);
+   "run:{"n":1}",
(fail) T10d (F3) a cancel while the clear's write hangs: ...
 1 pass / 3 fail
```

`resume.from: "c1"` while c1 is running means a crash at that point re-runs
c1. T10c passes on both the old and the new code by design: it pins a failure
mode, not the bug.

## Implementation

*— claude-opus-5-5, 2026-11-04*

### Load-bearing assumption

The daemon cannot see the gate's no-ask allow. The gate calls the requester
(`awaitDecision`) only when it asks (`permission-gate.ts:156-172`). Between
the allow and `execute`, the only code that runs is the agent's `runTool`
(`packages/agent/src/agent.ts:1468-1490`). So the hook has to be an
**agent-side seam**, awaited in `runTool` after the allow and before the run.
It is passed per turn, like `beforeRun` (`agent.ts:140`,
`session.ts:144-153`).

### Preconditions

- P1. A resumed turn runs its suspended round first, through `runToolCalls`
  (`agent.ts:~687`). Later rounds use the same method without a resume flag.
  So passing the hook only in that call scopes it to the resumed round.
- P2. Reload labelling: when the record has a running turn with no pending
  entry and no `inFlight`, the first unanswered call is labelled
  `INTERRUPTED_NOTE` and nothing is resumed (`persisted-session.ts:599`,
  `:666-675`). That is the honest label for "may have started".
- P3. `persist()` is a synchronous capture and `persisted()` never rejects: a
  failed write is reported by the persister (`hosted-session.ts:708-722`).
  `untilAborted` releases the wait on a cancel (`:260`). F1's
  clear-before-run already uses this exact pair (`:600-606`).
- P4. Only `startDaemon` gives a session a persister, and only a restored
  record has `resume` (`hosted-session.ts:419`, `:460`). Pod daemons and the
  in-process worker never reach this code. Even if they did, `persist()` is a
  no-op and `persisted()` resolves at once.
- P5. Steering window: the new await is inside the agent's `runTool`, which
  `drive` does not await. `drive` (`:1360+`) is not touched.

### Design

- **Agent** (`agent.ts`): a new `RunOptions.beforeResumedCall?:
  (signal) => Promise<void>`. `runMessages` passes it to the resumed round's
  `runToolCalls` only, which hands it to `runTool`. After the gate allows a
  call (and after the existing abort and refusal checks), `runTool` awaits
  it, then checks the abort again. If the turn was aborted, the call is
  answered with `CANCELLED_TOOL_NOTE` and never starts.
- **Session** (`session.ts`): `ResumeOptions.beforeResumedCall` is passed
  through to the agent.
- **Daemon** (`hosted-session.ts`): `beforeResumedCall(signal)` does nothing
  when `carried` is empty. That covers an asked call (its settle cleared
  `carried`, F1) and any later call, so they cost no extra write. Otherwise
  it sets `carried = []` (all entries, not only this call's, for the same
  reason as F1), then calls `persist()` and awaits
  `untilAborted(persisted(), signal)`. This mirrors F1. It is passed to
  `session.resume` in the constructor (`:487`).

### Files

1. `packages/agent/src/agent.ts`: the type, the option, and the
   `runToolCalls` → `runTool` plumbing, plus the await and abort check.
2. `packages/agent/src/session.ts`: the `ResumeOptions` field, passed through.
3. `packages/daemon/src/hosted-session.ts`: `beforeResumedCall` and the
   wiring at resume.
4. `packages/daemon/test/persistence.test.ts`: T10, T10b–T10e.

### Failure modes

| Case | Behaviour | Pinned by |
|---|---|---|
| Crash while a no-ask resumed call runs | Nothing is pending on disk, so the reload labels the call "Interrupted" and runs nothing | T10 (crash + reload end to end) |
| A group of several calls (carried `c2{groupStart:c1}`, all no-ask) | Clearing at c1 drops c2's entry too, so the reload does not resume from c1. c2 runs after c1's commit, which already cleared `carried` | T10b |
| The write is slow | The call waits for it (that is the property itself) | T10e |
| The awaited write fails | Same rule as task 5's `beforeRun` and the clear-before-run: a failed write never blocks the call (the daemon decides nothing on the user's behalf). The persister reports it and the call runs once | T10c |
| Cancel while the write hangs | `untilAborted` releases the wait; the agent re-checks the abort, so the call is cancelled and never starts | T10d |
| A resumed call that DOES ask | Unchanged. The settle clears `carried` (F1), so `beforeResumedCall` returns at once without a write | T9 and the existing resume tests |
| Pod daemons, the worker (no persister, no resume) | No change (P4) | structural |
| A refused or denied resumed call | The hook is never called (it runs only after an allow). The refusal is committed, which clears `carried` (`:1380`) | existing |
| A resumed `context_reset` call allowed without an ask | Out of scope, and no gap. Its gate is in `runContextReset` (`agent.ts:~1192`), with no hook. PREPARE has no effects, and the COMMIT barrier clears `carried` in the same synchronous stretch (`hosted-session.ts:1391`). A crash before that re-asks or re-runs a call that has done nothing yet | reasoning |

### Tests

Red first, on the buggy code: T10, T10b and T10d (Repro above). T10c pins a
failure mode. T10e was added during Execution (see below). Mutations, one per
behaviour:
- M1: the daemon never clears.
- M2: the clear is not awaited.
- M3: no abort check after the hook.
- M4: the agent never passes the hook, which is equivalent to the old code.

## Execution

*— claude-opus-5-5, 2026-11-04*

1. Wrote T10, T10b, T10c and T10d before any source edit. Result: 3 red, 1
   green by design (Repro).
2. Implemented in this order: agent (`agent.ts:140-156`, `:695`, `:1088-1095`,
   `:1140`, `:1452-1490`), then session (`session.ts:12`, `:46-47`,
   `:161-163`), then daemon (`hosted-session.ts:487-490`, `:760-777`). The
   persistence tests went 112/112 green.
3. Mutations. Copies of the sources are in `.tentacle/tmp/resumed-call-pending/`;
   `shasum -c` reported OK on `agent.ts`, `hosted-session.ts` and `session.ts`
   after the restores:

| Mutation | Red |
|---|---|
| M1 `beforeResumedCall` always returns early | T10, T10b, T10d |
| M2 `void` instead of `await` on the write | T10d only, at first. T10 stayed green because the store lands on a microtask before the tool runs, so **T10e was added** (held store: the call must not start). Re-run: T10e, T10d |
| M3 no abort check after the hook (`agent.ts`) | T10d |
| M4 resumed round passes `undefined` (the old behaviour) | T10, T10b, T10e, T10d |

**Drift:**
- D1. Added T10e, the M2 gap described above.
- D2. The hook's signature is `(signal)` with no call id. The daemon does not
  need the id: it clears everything carried, as F1 does.
- D3. `biome check --write` reformatted two lines (one call in `agent.ts`,
  one ternary in the test) after the mutations and after `tsc`. The change is
  whitespace only. The test run below happened after it.

**Gate** (worktree, foreground, run once each):
- `bunx tsc --noEmit` → 0 errors.
- `bunx biome check .` → 620 files, clean (after D3's whitespace fix).
- `bun test packages` → **4313 pass / 3 skip (opt-in) / 0 fail**, 4316 tests,
  292 files.

Not committed.

## Review

*— claude-opus-5-5, 2026-11-04*

**Verdict: PASS (APPROVE-WITH-NITS).** Only LOW findings. The invariant
"pending on disk ⇒ never started" now holds for a resumed call that the gate
allows without an ask. Reviewer note: same model as the executor, with only a
fresh context. Shared blind spots can survive both passes (AGENTS §10).

### Findings (all LOW)

1. **LOW (test coverage).** No test resumes through a hook `force: "allow"`
   or a session rule (`isRemembered`). T10–T10e use only `permission: "none"`.
   My mutation M6 (skip the hook when `outcome.hookName` or `modified` is
   set, `agent.ts:1484`) left all 461 tests green. All three no-ask allows go
   through the same single branch (`permission-gate.ts:156-164` → `run`), so
   the behaviour holds by construction. Only the pin is missing. Optional:
   add a hook-`force`d T10 variant.
2. **LOW (constraint for task 6).** Today the agent never calls `beforeRun`
   (grep: no call site in `agent.ts`), so there is no ordering conflict yet.
   When task 6 wires the parallel executor, the resumed round's
   one-at-a-time fallback (`beforeRun → false`) must still pass
   `beforeStart`. Otherwise this gap reopens on that path. A landed
   `inFlight` is safe by itself: `resumableTurn` refuses a record with
   `inFlight` (`persisted-session.ts:599`). *Answered in
   [`feat/parallel-tools`](../feat/parallel-tools.md): the hold runs once per
   group, before `beforeRun`, so the fallback starts with no carried entry
   (pinned by T-F3b; the hook-`force`d variant is T-F3d).*
3. **LOW (gate environment, not the diff).** In this worktree, `bun run check`
   stops at `tsc -p apps/mobile` (no Expo install). Worse, that failing `tsc`
   **emits** six `.js` files into `apps/mobile/`, and they then make
   `biome check` fail with 82 errors. I deleted them after confirming that
   each one has a `.ts`/`.tsx` source and that none was in the status at
   session start. A worktree gate should run the root steps separately, as
   the Execution did.

### Gate (run once, foreground)

- `bun run check` → stopped at `tsc -p apps/mobile` (environment, F3 above).
- `bunx tsc --noEmit` → OK.
- `bunx biome check .` → 620 files, clean (after removing the emitted `.js`).
- `bun test packages` → **4313 pass / 3 skip (opt-in) / 0 fail**, 4316 tests,
  292 files. This matches the Execution exactly.

### Mutations

Backups are in `.tentacle/tmp/resumed-call-pending-review/`. After each
restore, `shasum` matched the original (`hosted-session.ts 73c82cf…`,
`agent.ts 3a2c7d9…`).

| Mutation | Result |
|---|---|
| M2 (executor's): `void` instead of `await` on the clear's write | T10e and T10d red, 3 pass. This reproduces the Execution's table. |
| M5 (mine): keep the awaited write, drop `this.carried = []` | T10 and T10b red. This is the core property: the write must actually drop the entry. |
| M6 (mine): skip the hook on a hook-allowed or modified outcome | Survives (finding 1) |

### Premise table

| Premise | Verdict |
|---|---|
| Symptom: on the old code, the record on disk while c1 runs still resumes from c1 | TRUE. Not re-run on `main`; M5 (equivalent to "never clear") reproduces `resume.from` set and the re-run. |
| `carried` is set from `resume.pending` (`hosted-session.ts:472`) | TRUE |
| Re-ask filter, F1 settle clear, commit and reset clears (`:576`/`:600`/`:1380`/`:1391` on `main`) | TRUE. With the diff they are at `:579`/`:603`/`:1403`/`:1414` (+3 lines from the resume wiring). |
| No-ask allows: `force: "allow"`, `permission: "none"`, `isRemembered` (`permission-gate.ts:156-164`) | TRUE |
| P2: no pending and no `inFlight` ⇒ the first unanswered call is "Interrupted", nothing resumes (`persisted-session.ts:599`, `labelUnansweredCalls`) | TRUE |
| P3: `persist()` captures synchronously; `persisted()` (flush) never rejects; `untilAborted` | TRUE (`:708-722`, same pair as F1 at `:603-610`) |
| P4: only a restored record with a persister reaches the hook | TRUE. Wired only at the resume call (`:487-490`); without a persister the write is a no-op and the wait ends at once. |
| P5: no new await in `drive` | TRUE. The diff does not touch `drive`; the await is inside `runTool`. |
| Record version | Not touched (no schema change, so none is needed). TRUE. |

### Attacks tried

1. **Second crash after a no-ask allow.** T10 is a real end-to-end trace
   through `HostedSession` + `Agent` + the persister. It snapshots the
   durable record from inside the tool, reloads it, and checks that the call
   is labelled "Interrupted" and never runs again. It is killed by M5.
   **Holds.**
2. **The awaited write fails.** `persisted()` never rejects, so the call runs
   once and the persister reports the error (T10c). On disk the entry is then
   stale, so a crash inside that run would re-run the call. This is the same
   accepted rule as F1's clear-before-run (the daemon decides nothing itself)
   and it fails loud through the persister. **Accepted, consistent.**
3. **Cancel while the write hangs.** `untilAborted` releases the wait, and
   `agent.ts:1487` answers `CANCELLED_TOOL_NOTE` before `execute` (T10d,
   executor M3). **Holds.**
4. **Ordering against the gate.** The hook runs only after the
   abort/refusal checks (`agent.ts:1474-1483`), so a refused, denied or
   cancelled resumed call never clears. The commit clears it later
   (`:1403`). It runs after `tool_start` and before `execute`, which fits
   task 6's laptop "Interrupted if `tool_start` was seen". **Holds.**
5. **Groups.** In `c2{groupStart:c1}`, the clear at c1 drops c2's entry too
   (T10b). If c2 asks, its live ask is persisted normally. If c1 asks, F1's
   settle empties `carried`, so the hook is a no-op with no extra write.
   **Holds.**
6. **Paths that skip the hook.** An unknown tool (`agent.ts:1462`) runs no
   gate, but `ToolRegistry.execute` returns `unknown tool` with no effect
   (`registry.ts:74-76`). `context_reset` (`runContextReset`) has no hook;
   the doc's reasoning holds (PREPARE has no effects, and the COMMIT barrier
   clears `carried` at `:1414`). Sub-agent entries are never resumable.
   **Nothing found.**
7. **Pod daemons and the worker.** They have no `resume` and no persister,
   and the hook is never wired for a fresh send (`:1153`, `:1334` pass only
   `beforeRun`). **Unchanged.**

### What holds

The diff is minimal and additive (agent seam → session pass-through → daemon
hook), with no protocol, record or `drive` change, and it mirrors F1's proven
clear-and-wait pattern. Tests T10, T10b, T10d and T10e are non-vacuous (M2,
M5 and the executor's M1–M4).

### Executor behaviour

The executor followed the plan in order and wrote the tests red first. When
M2 survived, it found the gap honestly and added T10e, rather than claiming
coverage it did not have. It recorded its drift (D1–D3). Its gate numbers
match mine exactly. The only gap is the uncovered hook-`force` variant
(finding 1).
