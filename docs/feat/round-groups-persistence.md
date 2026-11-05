# feat/round-groups-persistence — Round groups on disk: `groupStart`, durable `inFlight`, exact reload labels

> **Status:** implementation (refreshed on the rebased tree, 2026-11-04)
> **Branch:** `feat/round-groups-persistence` — permission-reply's rebased commit (`6270f40`, on `main` @ `0874c46`) plus this task; both merge together (owner, 2026-11-04)
> **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review that red-teams the §7 *Persistence* invariant ("pending on disk ⇒ never started") and the steering invariant of `drive`

Type: feat · Size: M · Blast: load-bearing · Suited: strong model + fresh-context Review

## Context

*— claude-opus-5-5, 2026-10-27 · refreshed 2026-11-04*

This is task 5 of [`docs/eval/parallel-execution-plan.md`](../eval/parallel-execution-plan.md)
(split table `:574`). Tasks 1–4 are merged in `main`.

Task 6 (`feat/parallel-tools`) will run a round in **groups**, in two phases:
- **Phase 1:** authorize the group's calls one at a time, in call order.
- **Phase 2:** run the authorized calls concurrently.
- The `tool` messages are then pushed in call order when the whole group has
  settled, followed by ONE `history_commit` (plan §1.1, `:210-238`).

Today's daemon persistence assumes calls run one at a time, in two places:

1. **The suspension predicate.**
   - `suspendedCalls` (`packages/agent/src/resume.ts:21-44`) accepts only an
     answered prefix that ends EXACTLY at the asking call (`:35`).
   - In phase 1, call *j* asks while the earlier calls of its group are
     authorized but unanswered. So `classifyPending`
     (`packages/daemon/src/persisted-session.ts:371-382`) records *j* as
     non-resumable.
   - The reload then labels the group's first call "Interrupted". That is
     false: the call never started. This is repro B below.
2. **The reload labels.** `answerUnansweredCalls`
   (`persisted-session.ts:442-465`) gives only the FIRST unanswered call the
   `firstNote`; every later call gets "Not run". Its rationale is "Only the
   FIRST unanswered call can have started (calls run in order)" (`:436-437`).
   In phase 2, every call of the group may have started.

Owner decisions this task implements:
- **PE-Q2 (2026-10-26, `parallel-execution-plan.md:612`): R2.**
  - a durable `inFlight` set;
  - exact "Interrupted" / "Not run" notes;
  - one awaited write per parallel group, only on `serve`.
- **PR-Q0 (2026-10-27, `docs/feat/permission-reply.md:827`).** ONE shared
  record **v8**.
  - permission-reply introduces it (`denialReply` + the `head` mark).
  - This task extends the SAME v8 (`pending[]` + `inFlight`) under the same
    `V8` gate (`persisted-session.ts:52`; the version comment `:35-43` already
    says so).
  - The two merge together, so no build ever ships a v8 without these fields.
- **Task 4 deferred one item here:** `pending` as a list on disk. Today
  `pendingForRecord` (`persisted-session.ts:391-395`) writes ONE entry, and
  none when several asks are live.

The plan's promise is that **with groups of one, everything is identical to
today**: resume, labels and write points, all pinned. Task 5 creates no group
of more than one. The R2 path is driven in tests through the seam.

**Repro.** This is the eval's repro B (2026-10-26, `main` @ `5e8b538`; the
script is at `parallel-execution-plan.md:123-140`, the output at `:166-169`).
The code path is unchanged on this branch (`suspendedCalls` `resume.ts:21-44`,
`classifyPending` `:371-382`).

```
B. classifyPending(c2) = false; suspendedCalls(c2) = null; suspendedCalls(c1) = c1,c2
B. reload resumes? false
   c1: Interrupted: the daemon restarted while this tool was runnin…
   c2: Not run: the daemon restarted before this call ran (it was w…
```

In this repro, the group is `[c1, c2]` and c2 is asking; nothing has started.
Today the turn is not resumable, and c1 is falsely labelled "Interrupted".
Before any edit, the executor re-runs the repro, calling
`classifyPending(messages, "c2", "call", tool)` (the 4-argument signature),
and turns it into the red test T1.

## Implementation

*— claude-opus-5-5, 2026-10-27 · refreshed 2026-11-04*

### Refresh 2026-11-04 (what changed since the 2026-10-27 plan)

*— claude-opus-5-5, 2026-11-04*

Every `file:line` below was re-verified on the rebased tree
(`6270f40` + its uncommitted test fix). What moved or changed:

- **Record version: decided, no longer a question.** Owner PR-Q0 already
  chose one shared v8; permission-reply landed it with a `V8` gate
  (`persisted-session.ts:44-52`).
  - This task adds its fields under that gate and does **not** bump.
  - `packages/cli/test/serve-persistence.test.ts` already pins `8` (`:134`,
    `:200`) and refuses `9` as "newer" (`:289`).
  - **The plan's former `cli` test edit is gone: no `packages/cli` file
    changes.**
- **The reload labels moved into a shared helper.** The labels now live in
  `answerUnansweredCalls(messages, notRun, firstNote)`
  (`persisted-session.ts:442-465`, used at `:597-600`). Main (detach-live Q2)
  also calls it from the LAPTOP, in `cutHistory`
  (`packages/cli/src/local-runtime.ts:233-240`). That call labels a session
  ended mid-turn: first unanswered call "Interrupted", the rest "Not run".
  - This task keeps that function's signature and behaviour, so the cli caller
    is unchanged.
  - It adds a general labeller next to it (Design 6).
  - The laptop side of parallel rounds is Owner question 3.
- **`head` (v8) is new in the record and the parser.** It is set in
  `persistedState` (`hosted-session.ts:716-731`) and parsed at
  `persisted-session.ts:285-300`. Synthetic tool answers are appended AFTER
  the marked head, so its index is unaffected.
- **New on the ask path, orthogonal to this task:**
  - `SettledAnswers` (`hosted-session.ts:335`): an identical re-sent answer is
    treated as settled.
  - `PermissionResponse.message`, the reply, returned after
    clear-before-run (`:578-590`).
  - `keepDenialReply` in the round (`agent.ts:1112`).

  None changes the shape argument. A denial with a reply in phase 1 is a
  precomputed result (task 6).
- **Line numbers moved** throughout:
  - `agent.ts`: `runToolCalls` is `:1053-1126`, `runTool` is `:1416`.
  - `hosted-session.ts`: `awaitDecision` is `:500`, `drive` is `:1308`.

  All are cited fresh below.

### Load-bearing assumption

**"Pending on disk ⇒ never started" keeps holding, and a call that may have
started is never labelled "Not run".**

Today two facts carry it:
- **Clear-before-run.** After an ask settles, the daemon writes the record
  without it and awaits that write BEFORE the gate returns
  (`hosted-session.ts:578-584`).
- **Calls run in order.** Only the first unanswered call can be running: one
  `for` loop, with a push and a `history_commit` per call
  (`agent.ts:1053-1126`, `:1120-1122`).

R2 replaces the second fact with a durable write: a group's `inFlight` is on
disk BEFORE any of its calls runs. That write is awaited inside the agent's
generator, never in `drive`'s loop, which must stay free of awaits
(`hosted-session.ts:1296-1306`). This holds by construction: the agent awaits
`opts.beforeRun` between phase 1 and phase 2, and `drive` only sees the events
before and after it.

### Preconditions

All checked on the rebased tree.

- **P1. One shared predicate.** `suspendedCalls` serves:
  - the agent's resume (`agent.ts:600-603`, which raises `ResumeShapeError`
    before anything runs);
  - capture (`classifyPending`, `persisted-session.ts:380`);
  - reload (`resumableTurn`, `:545`).
- **P2. Clear-before-run, and an abort cannot hang on disk.** After an ask
  settles, the daemon runs `persist()` then
  `await untilAborted(this.persisted(), signal)` (`hosted-session.ts:578-584`).
  The agent checks the abort before running the tool (`agent.ts:1432-1434`).
- **P3. `schedule` captures synchronously and is never awaited.**
  - `schedule` itself is synchronous (`session-persister.ts:88-99`).
  - `persisted()` = `flush`, which never rejects: a failed write is reported
    through `onError` (`:15`, `:95-96`; `hosted-session.ts:698-700`).
- **P4. Commits are synchronous capture points.** Each of these clears
  `carried` and persists in the same stretch:
  - `history_commit` (`hosted-session.ts:1320-1329`);
  - `context_reset` (`:1334-1338`);
  - `finishTurn` (`:1424-1428`).
- **P5. Pods and the worker have no persister.**
  - `persist()` is a no-op without one (`hosted-session.ts:687-691`), and
    `persisted()` resolves at once (`:698-700`).
  - Only `startDaemon` gives `SessionHost` a persister (AGENTS §7,
    *Persistence*).

  So R2 costs pods and the worker nothing, and nothing pod-supplied becomes
  durable (§7, "a pod is not trusted").
- **P6. Per-turn options reach the agent without the CLI.**
  - `Session.send(…, opts: SendOptions)` (`packages/agent/src/session.ts:21`)
    forwards to `agent.runMessages(…, RunOptions)` (`:99-104`), and so does
    `Session.resume` (`:135-140`).
  - `HostedSession` calls them directly (`hosted-session.ts:1076`, `:1256`,
    `:478-481`).

  So a per-turn `beforeRun` needs no `packages/cli` wiring.
- **P7. Sub-agents.**
  - A sub-agent runs its own `child.run` (`subagent.ts:233`), never with the
    parent's `RunOptions`.
  - Its asks go through `subagentRequester` (`subagent.ts:99-113`), which
    SPREADS the child's options (`...rest`, `:105-107`) and strips only
    `toolCallId`.
  - So a new options field would leak unless it is stripped too.
- **P8. The gate builds the options.**
  - It passes `{ toolCallId: call.toolCallId, origin: "call" }`
    (`permission-gate.ts:166-169`).
  - `GateCall` is defined at `:96-100`.
  - `runTool` builds it at `agent.ts:1423-1427`.
  - The `PermissionRequestOptions` fields are at
    `packages/core/src/permission.ts:113-123`.
- **P9. Record v8.** These facts come from permission-reply.
  - `DAEMON_RECORD_VERSION = 8`; `READABLE_VERSIONS` is 1..8; the gate is
    `V8 = 8` (`persisted-session.ts:44-52`).
  - An unknown version is refused (`:227-232`), and the file is blocked, never
    overwritten (`session-persister.ts:79-85`).
  - `turn.pending` is still ONE object, validated at `:194-205`.
  - `PendingPermission` is at `:55-61`; `PersistedTurn` at `:64-71`.
- **P10. Archive uses the same capture.**
  - `archive()` builds from `persistedState()` (`hosted-session.ts:1766-1772`).
  - An ended session's turn is closed with the `ENDED_*` notes
    (`persisted-session.ts:585-600`).
- **P11. Nothing here is on the wire.** `toolCallId` / `origin` / `agent` are
  laptop-internal options (`core/src/permission.ts:113-123`); only `agent` is
  projected onto `permission_request` (task 4).
- **P12 (new).** `answerUnansweredCalls` has two callers: the daemon reload
  (`persisted-session.ts:597`) and the laptop's `cutHistory`
  (`cli/src/local-runtime.ts:240`).

### Design

**1. A group anchor on every own-call ask (`groupStart`).**
- `core`: `PermissionRequestOptions.groupStart?: string`, the first call of
  the asking call's group. Absent means "the call itself".
- `agent`:
  - `GateCall.groupStart?`; the gate forwards it next to `toolCallId`.
  - `runTool` passes `groupStart: call.id`. In task 5 every call is its own
    group; task 6 passes the real head.
- `subagentRequester` strips `groupStart` as it strips `toolCallId`: a child's
  id is unknown to the parent history.

**2. One generalised predicate, shared (`resume.ts`).**
- `suspendedInGroup(messages, groupStart, toolCallId)` returns
  `suspendedCalls(messages, groupStart)` iff it is non-null AND contains
  `toolCallId`; otherwise `null`. With `groupStart === toolCallId` it IS
  `suspendedCalls`.
- `classifyPending(messages, toolCallId, origin, requestTool, groupStart?)`
  holds iff:
  - `origin === "call"`, and
  - the asking call found through `suspendedInGroup` is named `requestTool`.
- `resumableTurn` uses the same function.
- The agent's `resumeFrom` keeps `suspendedCalls`. The daemon resumes from
  `groupStart`, the first unanswered call, so the agent's check is exactly
  the base predicate.
- The group's earlier approvals are asked again: approvals are per incarnation
  (`suspended-turn-resume.md` P5).

**3. Record v8, extended (no bump; PR-Q0).**
- `PendingPermission.groupStart?: string`. Absent means `toolCallId`, so every
  v1–v7 entry reads as before.
- `PersistedTurn.pending?: readonly PendingPermission[]`: in request order,
  non-empty.
- `PersistedTurn.inFlight?: readonly string[]`: call ids, non-empty.
- Parser (`turnProblem`, `:183-206`):
  - `version >= V8`:
    - `pending` must be an array of well-formed entries;
    - `groupStart` is a string if present;
    - `inFlight` is a non-empty string array if present.
  - `< V8`:
    - `pending` keeps today's object check and is wrapped as `[it]`;
    - an `inFlight` there is malformed.
- `pendingForRecord` is deleted. `persistedState` (`hosted-session.ts:715`)
  writes `pendingList()` (`:703-706`) as is.
- One more clause in the v8 version comment (`:35-43`).

**4. The `beforeRun` seam (R2).**
- `agent`:
  - `RunOptions.beforeRun?: (ids: readonly string[], signal: AbortSignal) => Promise<void>`
    (`RunOptions` at `agent.ts:93`).
  - Contract:
    - The round executor awaits it after phase 1 and before any call of a
      group of MORE THAN ONE call runs. `ids` = the authorized, not-cancelled
      calls.
    - After it resolves, the executor re-checks the abort. If aborted, those
      calls are answered `CANCELLED_TOOL_NOTE` and never start.
  - **Task 5 adds the type and contract only; the call site is task 6's
    executor** (no multi-call group exists yet). *Done in
    [`feat/parallel-tools`](parallel-tools.md): `Agent.runGroup`.*
  - It is never called for a group of one, so the sequential write points do
    not change.
- `SendOptions.beforeRun?`, passed through `Session.send`. Same option on
  `Session.resume(toolCallId, signal, opts?)`.
- `daemon` (`HostedSession`):
  - Passes `beforeRun` on both `send` calls (`:1076`, `:1256`) and on the
    resume (`:478-481`).
  - `beforeRun` sets `this.inFlight = [...ids]`, then `persist()`, then
    `await untilAborted(this.persisted(), signal)`. This is the P2 pattern.
  - `persistedState` writes `turn.inFlight` while it is set.
  - Cleared beside `carried`: at `history_commit` (`:1320-1329`; the group's
    ONE commit captures its results and the clear together), at
    `context_reset` (`:1334-1338`), and at `finishTurn` (`:1424-1428`).
- `drive` gains no await.

**5. Resume (reload) with a list.** `resumableTurn` (`:539-557`) resumes iff:
- the record is not archived;
- `inFlight` is absent;
- `pending` is non-empty, and every entry is `resumable` with the SAME
  effective `groupStart`;
- `suspendedInGroup` holds for each entry, with names matching;
- the turn key is open.

What the resume carries:
- `ResumedTurn` gains `from` (= `groupStart`).
- `pending` becomes the list, so `carried` (`hosted-session.ts:327`, `:466`)
  becomes a list. An ask replaces the carried entry with its `toolCallId`
  (`:559`).
- The daemon calls `session.resume(from, …)` (`:480`).
- Sequentially there is one entry and `from === toolCallId`: today's path.

**6. Reload labels.**
- Add `labelUnansweredCalls(messages, noteFor: (callId, isFirst) => string)`
  next to `answerUnansweredCalls`. The latter becomes a one-line delegate, with
  the same signature and behaviour, so the laptop's `cutHistory` is unchanged.
- `reconcileOnReload` (`:597-600`) uses the new function. For each unanswered
  call:
  - **`inFlight` present:**
    - call in `inFlight` → "Interrupted", or the sub-agent note if a
      non-`resumable` pending entry names it;
    - otherwise → "Not run". These are phase-1 denials not yet pushed, and
      later groups.
  - **`inFlight` absent:** today's rule.
    - The first unanswered call gets "Interrupted" if no entry names it,
      "Not run" if its entry is resumable, else the sub-agent note.
    - Every later call gets "Not run".
- The `ENDED_*` variants apply the same way. The note texts are unchanged.

**Protocol impact: none.** No wire field, update kind or method changes, and
`PROTOCOL_VERSION` stays 14 (`protocol/src/version.ts:7`). The on-disk format
is versioned separately: same v8, more fields.

### Files

Dependency order (core → agent → daemon): 8 source files, 0 in `packages/cli`.

1. `packages/core/src/permission.ts`: `groupStart?`.
2. `packages/agent/src/resume.ts`: `suspendedInGroup`. Also
   `packages/agent/src/index.ts` if it must be exported.
3. `packages/agent/src/permission-gate.ts`: `GateCall.groupStart?`, forwarded.
4. `packages/agent/src/agent.ts`: `RunOptions.beforeRun` (type + contract);
   `runTool` passes `groupStart: call.id`.
5. `packages/agent/src/subagent.ts`: strip `groupStart`.
6. `packages/agent/src/session.ts`: `beforeRun` through `send` / `resume`.
7. `packages/daemon/src/persisted-session.ts`:
   - the v8 turn fields and parser;
   - `classifyPending` + `groupStart`;
   - `resumableTurn`;
   - `labelUnansweredCalls`;
   - drop `pendingForRecord`.
8. `packages/daemon/src/hosted-session.ts`:
   - `groupStart` into the record;
   - `carried` as a list;
   - `inFlight` + `beforeRun` + the clears;
   - resume from `from`.

Tests:
- `packages/agent/test/{resume,permission,subagent}.test.ts`
- `packages/daemon/test/persistence.test.ts`

Docs:
- the v8 note in `docs/feat/suspended-turn-resume.md` and
  `docs/feat/daemon-side-persistence.md`;
- the `TODO.md` line.

**Overlap with Docker slices (`cli`/`k8s`/`docker`): none.** `cutHistory` is
deliberately left alone (Owner question 3).

### Failure modes

- **Crash in phase 1 with an ask pending** (group `[a, b, c]`, *b* asking).
  - On disk: `pending=[{b, groupStart:a, resumable}]`, no `inFlight`.
  - The reload resumes from *a*: *a* and *b* are asked again. Nothing ran.
  - If the session was archived, the turn is closed instead. The first
    unanswered call (*a*) gets "Interrupted" because no entry names it, though
    it never ran. Residual, Owner question 1.
- **Crash in phase 1 with no ask outstanding** (hooks or auto-allow running).
  - *a* is labelled "Interrupted".
  - This is the conservative direction, never "Not run" for a call that ran.
    Owner question 1.
- **Crash mid-group (phase 2).** On disk, `inFlight = ids`.
  - Each unanswered id → "Interrupted", or the sub-agent note.
  - Everything else → "Not run".
  - The turn is never resumed. All labels are exact.
- **Crash between the awaited write and the run.** Calls that never started
  are labelled "Interrupted". Conservative; the window is microtasks.
- **Cancel during the `beforeRun` write.** `untilAborted` releases the agent,
  which re-checks the abort. Every id is answered cancelled, and the group's
  commit clears `inFlight`.
- **The `beforeRun` write fails** (`persisted()` still resolves, P3).
  - A later crash reloads an older record without `inFlight`. A call that ran
    could then read "Not run": the dangerous direction.
  - This is the same class as today's failed clear-before-run, which could
    re-run a call.
  - Owner question 2.
- **Reload of a v1–v7 record.** It reads as `pending=[it]`, with
  `groupStart = toolCallId` and no `inFlight`. Resume and labels are exactly
  today's (T6). The next write is v8.
- **A v8 record read by a v7 daemon.** It is refused and the file is blocked
  (P9). This is already pinned (`serve-persistence.test.ts:289`, `session-titles`).
- **Malformed v8 turn fields.** The record is refused, never half-loaded.
  Malformed means any of:
  - `pending` not an array, or empty;
  - an entry malformed;
  - `inFlight` not a non-empty string array;
  - `inFlight` in a record below v8.
- **Pod daemons / the worker** (no persister). `beforeRun` sets a field that
  nobody writes and resolves at once (P5).
- **A sub-agent's `groupStart` leaks.** It is stripped (P7). `origin:
  "subagent"` would keep the ask non-resumable anyway.
- **Pending entries that disagree on `groupStart`, or one that is not
  resumable** (from task 6/7). The turn is not resumed and is closed honestly.
- **Steering window.** No await is added to `drive`; the clears sit in
  existing synchronous stretches (P4).
- **Laptop copy of a session ended mid-turn** (`cutHistory`). Unchanged in
  task 5. With groups of one it stays exact. In a parallel group it would mark
  only the first unanswered call "Interrupted". Owner question 3; it must be
  settled before task 6 ships.

### Tests

Red before green. Each one is shown failing on the rebased tree first.

- **T1 (red, repro B).** `classifyPending(messages, "c2", "call", "fs_read", "c1") === true`,
  and `suspendedInGroup(msgs, "c1", "c2")` returns `[c1, c2]`. Unit tests in
  agent `resume.test.ts` and daemon `persistence.test.ts`.
- **T2 resume from the group head.** A v8 record with
  `pending=[{c2, groupStart:c1}]` reloads with `from === "c1"`. The scripted
  agent asks c1, then c2. Red today: the turn is closed.
- **T3 labels with `inFlight`.** A record `[c1, c2, c3]` with
  `inFlight=[c1, c2]` and a sub-agent entry for c2 gives: c1 "Interrupted",
  c2 the sub-agent note, c3 "Not run". Repeat with `archivedAt` to get the
  `ENDED_*` notes.
- **T4 the durable write precedes the run.**
  - Patch `agent.runMessages` (pattern at `persistence.test.ts:886-903`) to:
    1. yield `tool_start` ×2;
    2. `await opts.beforeRun(["c1","c2"], signal)`;
    3. read the record.
  - The record must hold `inFlight=["c1","c2"]`, and after the group's
    `history_commit` it must be gone.
  - Mutation: drop the `await` → the test fails.
  - A cancel during a hung flush (`docs/fix/cancel-hung-disk.md` fake) must
    release the wait.
- **T5 sequential is pinned.**
  - A multi-call sequential round never calls `beforeRun`.
  - The persister's write count is unchanged.
  - The existing persistence suite stays green.
  - `answerUnansweredCalls` gives the same output for its laptop call shape.
- **T6 v7 → v8 read.** v7 records, with a pending object (resumable, and
  sub-agent), give the same resume and labels as today. Each malformed-v8 case
  is refused with its reason.
- **T7 sub-agent strip.** `subagentRequester` drops a child's `groupStart`.
  Red: today it spreads it.
- **T8 gate.** `groupStart` reaches the requester options next to `toolCallId`
  (`permission.test.ts`).
- **Gate:** `bun run check`, against the clean lint baseline (§6).
  Prerequisite: `bun install --frozen-lockfile` in this worktree, because the
  `@noble/*` modules main added for the Noise channel are missing here.

### Owner questions (all of them, each with a recommendation)

1. **Phase-1 exactness.** When a crash happens in phase 1 with no resumable
   ask, or the session was archived, the group's first call reads
   "Interrupted" though it never ran. Accept this conservative label, or add a
   second awaited write per group (at its start) to make it exact?
   **Recommend: accept.**
   - It is never the dangerous direction.
   - The window is the gate's hooks only.
   - PE-Q2 budgeted one write per group.
2. **A failed `beforeRun` write.** Should `beforeRun` report whether the write
   landed (`Promise<boolean>`, from the persister's `writeRecord` result), so
   that task 6 runs that group ONE AT A TIME when it did not?
   **Recommend: yes.** Define the boolean in task 5's contract (the daemon
   returns `false` on a failed write), and let task 6 implement the
   sequential fallback. Honesty under disk failure costs only parallelism, and
   only when the disk is already failing. Today's equivalent hole, a failed
   clear-before-run, stays as it is (out of scope).
3. **Laptop `cutHistory` for parallel rounds** (`cli/src/local-runtime.ts:233-240`).
   The laptop has no `inFlight`. Options:
   - (a) label every unanswered call of the trailing message "Interrupted";
   - (b) label "Interrupted" every unanswered call the laptop saw a
     `tool_start` for, and "Not run" the rest;
   - (c) put `inFlight` on the wire.

   **Recommend: (b) in task 6, not here.**
   - Task 5 keeps the helper's signature, so `packages/cli` stays untouched
     while the Docker slices are open.
   - (b) is exact for every call the laptop watched, and conservative
     otherwise.
   - (c) is a protocol change for an edge case.

> **Owner decisions (2026-11-04):**
> 1. **ACCEPT** the conservative phase-1 "Interrupted" label (no second write).
> 2. **YES:** `beforeRun` resolves `Promise<boolean>`, `false` on a failed
>    write. It is defined in task 5's contract; task 6 implements the
>    one-at-a-time fallback.
> 3. **(b), in task 6, not here.** Task 5 leaves `packages/cli` untouched.

## Execution

*— claude-opus-5-5, 2026-11-04*

Built on the rebased tree (`6270f40` + the uncommitted `denial-reply-row.test.ts`
fix, kept). In the plan's order, each item red first. Nothing committed.

**As built**

1. **`groupStart` in the ask options.**
   - Field: `core/src/permission.ts:127`.
   - The gate forwards it: `GateCall.groupStart?` (`agent/src/permission-gate.ts:96-101`),
     spread at `:171`.
   - `subagentRequester` strips it (`agent/src/subagent.ts:106`).
   - Red: `subagent.test.ts` "the wrapper keeps the other options…" (the
     child's `groupStart` leaked).
2. **`suspendedInGroup`** (`agent/src/resume.ts:55-62`).
   - Red: `resume.test.ts` "suspendedInGroup" ×3 (missing export).
   - T1: `[c0✓, c1, c2, c3]` gives `(c1, c2) → [c1, c2, c3]`, while
     `suspendedCalls(c2)` is `null`.
3. **`classifyPending(…, groupStart?)`** (`daemon/src/persisted-session.ts:415-436`,
   via `askingCall`). `HostedSession.awaitDecision` records `groupStart` when
   given (`hosted-session.ts:536-549`).
4. **Record v8 turn fields.**
   - `PendingPermission.groupStart?` (`:74`); `PersistedTurn.pending` is a
     list and `inFlight?` is new (`:85-91`).
   - Parser: `pendingEntryOk` / `currentTurn` (`:235-250`); `groupStart` and
     `inFlight` are refused below v8.
   - `pendingForRecord` is deleted; `persistedState` writes the list and
     `inFlight` (`hosted-session.ts:751-790`).
   - The v8 comment is extended (`:35-52`).
5. **Resume with a list.**
   - `resumableTurn` (`:595-620`).
   - `ResumedTurn.from` replaces `toolCallId` (`:563-575`).
   - `carried` is a list (`hosted-session.ts:321-333`; replaced per call at
     `:576`).
   - Resume from `from` with `beforeRun` (`:487`).
6. **Labels.**
   - `labelUnansweredCalls` (`:497-515`). `answerUnansweredCalls` is now a
     one-line delegate with the same signature and output, so `cli`'s
     `cutHistory` is untouched.
   - The `inFlight` rule is at `:661-676`.
7. **`beforeRun` seam.**
   - `BeforeRun` type + `RunOptions.beforeRun` contract (`agent/src/agent.ts:128-144`).
   - `SendOptions.beforeRun` / `ResumeOptions` (`agent/src/session.ts:33-40`,
     forwarded at `:112`, `:152`).
   - `HostedSession.beforeRun` (`hosted-session.ts:726-749`), passed on both
     sends (`:1124`, `:1305`) and the resume.
   - `inFlight` is cleared beside `carried` at `history_commit` / `context_reset` /
     `finishTurn` (`:1375`, `:1386`, `:1479`).
   - New `SessionPersister.write(id, build): Promise<boolean>`
     (`daemon/src/session-persister.ts:97-112`). `schedule` delegates to it,
     same behaviour.

**Drift from the plan** (each one deliberate):

- **D1. A call alone sends NO `groupStart`.** The plan had `runTool` pass
  `groupStart: call.id`. That made `packages/cli/test/wiring.test.ts:107`
  fail: it pins the requester options exactly. Owner decision 3 says no `cli`
  edits.
  - The contract's "absent = the call itself" already covers it. Nothing in
    behaviour changes, and a sequential record entry keeps the exact v7 shape
    (T5 pins `"groupStart" in p === false`).
  - Forwarding is pinned at gate level instead: new T8 in `permission.test.ts`.
  - Task 6's executor passes the real group head.
- **D2. `ResumedTurn.toolCallId` is removed** in favour of `from`. With a list
  there is no single "asking call". The only consumer was the resume call.
- **D3. `beforeRun` returns `Promise<boolean>`** (owner decision 2). The
  daemon gets "landed" from the new `SessionPersister.write`.
  - No persister → `true`. Nothing needs to be durable, and a pod never
    reloads.
  - Closed session or aborted signal → `false`.
- **D4. Tests live in `persistence.test.ts`** (new `describe` "round groups on
  disk", `:3023`). There are no edits to `cli` tests, and the plan's "version
  literals" did not need one (v8 was already pinned).
  - The existing tests that built `turn.pending` as an object, in memory, were
    adapted mechanically to the list (`pending: [p]`, `?.[0]`).
  - Q9 (`:2388`) now downgrades the record honestly to v3: one object, no
    `groupStart`.
  - Task 4's "two live asks" test changed contract: the disk now holds BOTH
    entries (`x1`, `x2`, `resumable: false`). It is still closed on reload,
    with f1 labelled "Interrupted".
  - The `pendingForRecord` test is deleted together with the function.
- **D5. `TODO.md` is not touched.** The index line is for the merge.
- **D6. T4 needed strengthening.** The first "drop the await" mutation was
  equivalent: an async function returning `landed` still waits for it. The
  meaningful mutation is "resolve before the write lands" (`return true`
  without awaiting). T4 now also asserts `settledWhileHeld === false`, and
  turns red on that mutation.

**Mutations** (each applied by hand, with a copy kept in
`.tentacle/tmp/round-groups/`; restored and checked with `shasum -c` → OK):

| # | Mutation | Red |
|---|---|---|
| M1 | `subagentRequester` keeps the child's `groupStart` | 4 × `subagent.test.ts` |
| M2 | `suspendedInGroup` uses the asking call as the head | T1 (`resume.test.ts`) |
| M3 | `classifyPending` ignores `groupStart` | T1 (daemon) |
| M4 | no `< V8` wrap of a v1–v7 pending object | T6 + Q9 |
| M5 | `resumableTurn` resumes from the asking call | T2, T2b |
| M6 | labels ignore `inFlight` (first unanswered only) | T3 |
| M7 | `beforeRun` resolves `true` before the write lands | T4, T4b |
| M9 | no `inFlight` clear at the group's `history_commit` | T4 |
| M10 | the agent calls `beforeRun` outside a group | T5 |
| M11 | the gate does not forward `groupStart` | T8 |

**Gate** (2026-11-04, worktree):
- `bunx tsc --noEmit` → 0 errors.
- `bunx biome check .` → 611 files, clean (after `--write` formatting of two
  test files).
- `bun test packages` → **4207 pass / 3 skip (opt-in) / 0 fail** (4210
  tests). The baseline was 4195 / 3 / 0.

**Unverified:**
- The `beforeRun` call site and the sequential fallback on `false` are task 6;
  task 5's R2 path is exercised only through the seam (T4).
- How to verify: task 6's executor tests.

## Review

*— claude-opus-5-5, 2026-11-04* (fresh context; **same model as the
executor**: shared blind spots may survive both passes — a different model
for the follow-up Review would be stronger, AGENTS §10)

**Verdict: FIX** (REQUEST-CHANGES) — one MEDIUM finding on the load-bearing
invariant (F1); the rest are LOW/nits.

**Gate (re-run by the reviewer, worktree):**
- `bunx tsc --noEmit` → 0 errors.
- `bunx biome check .` → 611 files, no fixes.
- `bun test packages` → **4207 pass / 3 skip (opt-in) / 0 fail**, 4210 tests,
  286 files — matches Execution.

**1. Rebase (`git range-diff 5b77867~1..5b77867 b55ad2d..6270f40`): holds.**
- `remote-client.ts`: main's `VanishedError` kept (`:292`); the
  `SessionLostError` main still had in-file is byte-identical to
  `client/src/session-lost.ts` (imported `:82`) — nothing of main lost.
- `permission-ui.ts`: `usePermissionBroker(permissions, ownsTurn, feed?, onDraftBack?)`,
  `autoApprove` seeded from `feed`; `applyAuto` does `closeDraft("approved")`
  before the grant, deps `[answer, closeDraft]` — both intents kept.
- `App.tsx`: `AutoAcceptFeed` + `DraftBack` imported, args `autoAccept, draftBack`
  in the hook's order, `quitConfirm` precedence kept, `replyShown?.rows.length`
  added to `permissionPromptRows`.
- `denial-reply-row.test.ts` (uncommitted): only the expanded case gains the
  `│ rm -rf build` row (tui-tool-expand); the reply-only assertion and the
  "never the model text" check are unchanged — correct. Must be folded into
  the commit.
- Versions: `DAEMON_RECORD_VERSION = 8` (main 7 + 1), `PROTOCOL_VERSION` 14,
  untouched by task 5.

**Findings**

- **F1 (MEDIUM, FIX) — a carried group entry outlives its group's start:
  "pending on disk ⇒ never started" breaks on the resume path.**
  `hosted-session.ts:576` drops a carried entry only when ITS OWN call is
  asked again (or at a commit); `resumableTurn` (`persisted-session.ts:595-620`)
  resumes from `groupStart` whenever any such entry is on disk. Resuming a
  record `pending=[{c2, groupStart:c1}]` (exactly T2's shape), c1 is asked,
  approved, and **runs while the disk still says "resume from c1"**; a crash
  then re-runs c1. Repro (reviewer, temporary test appended to
  `persistence.test.ts`, then restored):
  ```
  R-A1 resumed from c1 (record: c2 asking in group c1): while c1 RUNS, the disk must not resume
  expect(seenWhileRunning[0]).toBeUndefined()   Received: "c1"   → 1 fail
  ```
  (the tool's `during` hook re-reads `store.durable` and runs
  `reconcileOnReload(reread(...)).resume?.from`).
  - Reach in task 5: no producer of `groupStart` yet — only a record written
    by a task-6 build (same v8, e.g. a downgrade). Latent, but it is the
    invariant this task exists to keep, and T2 drives exactly this path.
  - Reach in task 6: a resumed group whose carried entry is NOT re-asked
    (c1 answered "allow for session" → c2 auto-allowed by `isRemembered`,
    `permission-gate.ts:162`, no ask) is protected only by `inFlight` landing.
    On `beforeRun → false` the owner-mandated one-at-a-time fallback (decision 2)
    runs c1 with the stale `pending=[c2{gs:c1}]` on disk — the fallback is
    **not** honest in that case, contrary to decision 2's rationale.
  - Suggested fix (smallest, conservative): when an own-call ask settles
    (clear-before-run, `hosted-session.ts:~578-590`), drop ALL carried entries
    before that write — a reload then closes the turn (phase-1 "Interrupted",
    the accepted Q1 class) instead of re-running. Ship R-A1 as the regression
    test (red now).
- **F2 (LOW)** — `beforeRun` resolves `false` for a session the persister will
  never write (blocked file, unsafe id: `session-persister.ts:98-99`), so task 6
  would run that session's groups one at a time forever with no honesty gain
  (nothing durable either way, like "no persister → true"). Owner Q-R2.
- **F3 (LOW, pre-existing on `main`, same root as F1)** — a resumed call that
  is authorized without an ask (a hook `force: "allow"`, or a tool whose
  permission became `none` across the restart) runs with its carried entry
  still on disk (`permission-gate.ts:156-161`): a crash re-runs it. Not
  introduced here; F1's fix does not cover it (no ask settles). Owner Q-R3.
- **Nits:** the Execution's mutation table skips M8; T4b's first case calls
  `beforeRun(["c1"])`, a group of one, which the contract says never happens
  (harmless); the local `head` in `resumableTurn` (`persisted-session.ts:~597`)
  reads like the v8 `head` mark — `first`/`entry0` would be clearer.

**Premise table (Implementation P1–P12):** spot-checked P2 (clear-before-run
awaited, `hosted-session.ts:~578-590`), P3 (`schedule` sync, `write` returns
`writeRecord`'s never-rejecting `landed`, `session-persister.ts:88-166`), P4
(clears at `:1374-1375`, `:1385-1386`, `:1478-1479`, all in sync stretches of
`drive`/`finishTurn`), P7 (`subagent.ts:106` strips both ids), P8
(`permission-gate.ts:168-172`), P9 (`turnProblem` refuses unknown/malformed;
v9 refused by V8-1). All TRUE. P1's "one shared predicate" now means
`suspendedInGroup` (capture + reload) over `suspendedCalls` (agent) — TRUE as
designed.

**Attacks tried**
1. Steering window: `git diff` adds no `await` to `drive` (`:1355-1431`); the
   only new await is inside `beforeRun`, called by the agent. **Holds.**
2. Abort during a hung `beforeRun` write: `untilAborted` releases, returns
   `false`; the in-memory `inFlight` stays until the commit/`finishTurn`
   clear, so a later landed write is conservative ("Interrupted"). **Holds.**
3. Latest-wins store: a superseded `beforeRun` write resolves with the newer
   one, which (before the group commit) still carries `inFlight`, or (the
   commit) has the results. **Holds.**
4. Versions: v1–v7 pending object → one-entry list, `groupStart`/`inFlight`
   below v8 refused, empty list refused (T6); v8 refused by a v7 build (already
   pinned, V8-1 / `serve-persistence.test.ts`). **Holds.**
5. Archive mid-group: `archive()` captures `inFlight` → ENDED notes exact (T3
   archived case). **Holds.**
6. Carried entry across the group's start (R-A1). **Fails → F1.**

**Mutations (reviewer, each red, then restored; `git diff` byte-identical,
`shasum` 887b72fc… before = after):**

| Mutation | Red |
|---|---|
| M3 `classifyPending` ignores `groupStart` | T1 (daemon) |
| M6 labels from the first unanswered call only | T3 |
| M7 `beforeRun` returns `true` without awaiting the write | T4, T4b |
| **own:** `resumableTurn` ignores `inFlight` | T2b |

**What holds:** sequential behaviour is unchanged (T5; a call alone writes the
v7 entry shape); the record format is strict both ways; owner decisions 1–3
are implemented as recorded (no second write; `Promise<boolean>`;
`packages/cli` untouched, `answerUnansweredCalls` a same-output delegate).

**How the executor behaved:** disciplined — drift D1–D6 is declared with
reasons (D1 forced by a `cli` test the owner fenced off; D6 caught its own
equivalent mutation and strengthened T4). Claims about the gate and the
mutations reproduced exactly. Miss: the failure-mode list reasoned about a
carried entry only for the asking call, not for a sibling whose group starts
without re-asking it (F1).

**Owner questions (all):**
- **Q-R1 (F1):** fix in task 5 by dropping every carried entry when an own-call
  ask settles? **Recommend: yes, in task 5** (it is this task's invariant; the
  cost is a conservative "Interrupted" in a phase-1 crash, already accepted Q1).
- **Q-R2 (F2):** `beforeRun` for a never-persisted session (blocked/unsafe id):
  `true` (keep parallelism) or `false`? **Recommend: `true`**, like no persister.
- **Q-R3 (F3, pre-existing):** a resumed call authorized without an ask runs
  with its pending entry on disk. Track it as a `fix` in `TODO.md` (e.g. clear
  carried + awaited write at the gate's no-ask allow on a resumed call) or
  accept? **Recommend: track, not in this task.**

### Execution — fix round 1

*— claude-sonnet-5-5, 2026-11-04*

Owner answers (2026-11-04): **Q-R1 = yes, in task 5**; **Q-R2 = `true`**;
**Q-R3 = a separate fix in `TODO.md`, tracked by the orchestrator, NOT touched
here**. Nothing committed.

**F1 (Q-R1) — done.** `HostedSession.awaitDecision`, in `decided.then`
(`hosted-session.ts:~590`): `this.carried = []` before the clear-before-run
write. So when ANY ask settles, no carried group entry is left on disk. The
old per-call filter at the re-ask (`:576`) stays; it covers the window before
the answer.
- Regression test **T9** (`persistence.test.ts`, "round groups" describe): the
  reviewer's repro. The record has `pending=[{c2, groupStart:c1}]`. c1 is asked
  again and approved; while c1 RUNS (and later c2) the tool re-reads the disk
  and `reconcileOnReload(...).resume?.from` must be `undefined` both times.
- **Red before the fix:** `Expected undefined / Received "c1"` (the
  reviewer's value, exactly).
- Mutation: remove `this.carried = []` → T9 red. Restored.
- Cost: a crash in a resumed phase 1 after the first answer closes the turn
  ("Interrupted", the accepted Q1 class), instead of re-asking.

**F2 (Q-R2) — done.** New `SessionPersister.writable(id)`
(`session-persister.ts:~196`): false for a blocked file or an unsafe name,
silent. `HostedSession.beforeRun` returns `true` at once when there is no
persister OR `!writable(id)`. The doc comment says so.
- Test **T4d**: a persister with `block("s1")` → `beforeRun` resolves `true`,
  no save. Red before: `Received: false`.
- Mutation: drop the `writable` check → T4d red. Restored.

**F3 (Q-R3) — not touched**, as instructed.

**Nits folded in (same files, trivial):**
- `resumableTurn`'s local `head` renamed `first` (it is not the v8 `head`).
- T4/T4b/T4c/T4d call `beforeRun(["c1", "c2"])`: a real group, as the contract
  says.
- The reviewer's "M8 skipped": M7's "resolve `true` before the write lands"
  already covers an always-`true` `beforeRun`; there is no separate M8.

**Drift:** none from the fix-round brief. Files: `hosted-session.ts`,
`persisted-session.ts` (rename only), `session-persister.ts`,
`persistence.test.ts`.

**Mutations** (copies in `.tentacle/tmp/round-groups/fix1/`, restored,
`shasum -c` OK on the three sources).

**Gate (worktree):** `bunx tsc --noEmit` → 0; `bunx biome check .` → 611
files, clean; `bun test packages` → **4209 pass / 3 skip / 0 fail** (4212
tests; was 4207).

**Open owner questions:** none. Still for a re-Review: a different model than
the executor and the first reviewer (both were Opus 5.5), per the Review's own
note.

### Review — round 2 (2026-11-04)

*— claude-opus-5-5, 2026-11-04* (the same reviewer and model as round 1; the
fix round was executed by claude-sonnet-5-5, so at least the fix and its
review come from different models)

**Verdict: PASS.** F1 is closed and F2 is done as the owner answered. No
regression found. What remains is LOW or tracked elsewhere.

**Gate (re-run by the reviewer, worktree):**
- `bunx tsc --noEmit` → 0 errors.
- `bunx biome check .` → 611 files, no fixes.
- `bun test packages` → **4209 pass / 3 skip (opt-in) / 0 fail**, 4212 tests,
  286 files. This matches the fix round's claim; the +2 are T4d and T9.

**F1 (Q-R1): closed.**
- `hosted-session.ts:600`: `this.carried = []` runs inside `decided.then`,
  before the clear-before-run `persist()`, in the same synchronous stretch. So
  the awaited write (`:606`) already lacks every carried entry by the time the
  gate returns and any call of the group can run.
- The reviewer's original repro (R-A1), appended again temporarily, is
  **green** now.
- T9 is the same scenario and also checks the disk at c2's run.
- **Mutation** (restore the old per-call drop at settle,
  `carried.filter(p => p.toolCallId !== toolCallId)`): **T9 and R-A1 both
  red** (`107 pass / 2 fail`). Restored.
- Red-teamed the broader clear. It drops carried entries on ANY settle (a
  sub-agent's ask, a denial, a cancel). Dropping an entry can only change a
  reload's label from "Not run" (a resumable entry for the first unanswered
  call) to "Interrupted", or end a resume. It never labels a call that may
  have started "Not run", and it never resumes. So the change is conservative
  in every case. Its cost is the accepted Q1 class: a crash in a resumed
  phase 1 after the first answer closes the turn instead of re-asking.

**F2 (Q-R2): done as answered.**
- `SessionPersister.writable(id)` (`session-persister.ts:~196`) is false for a
  blocked file or an invalid id, and silent. Reporting stays on the write
  path, once per id.
- `beforeRun` returns `true` when there is no persister or when the id is not
  writable (`hosted-session.ts:~758`).
- **Mutation** (drop the `writable` check): **T4d red** (`108 pass / 1 fail`).
  Restored.

**Nothing else regressed:**
- **Steering window:** the fix adds no `await` to `drive`. The only new
  statement is in the gate's settle continuation, which already awaited
  before.
- **§7 Persistence invariant** ("pending on disk ⇒ never started"): it is
  stronger than in round 1, as shown above.
- **Record versions:** the format and parser did not change in this round;
  the only edit in `persisted-session.ts` is the `head` → `first` rename in
  `resumableTurn`. T6/V8-1 are green in the full run.
- **Tree:** after the mutations, `git diff` is byte-identical (`shasum`
  5b57072d… before = after).

**Remaining (LOW / tracking):**
- **F3** (pre-existing on `main`: a resumed call authorized without an ask
  runs while its carried entry is still on disk) is untouched, as the owner
  decided. It is **not yet in this worktree's `TODO.md`**: the orchestrator
  must add it on `main` so it is not lost.
- The `denial-reply-row.test.ts` fix is still uncommitted. It must be folded
  in at the merge (round 1).

**How the executor behaved (claude-sonnet-5-5):**
- Scope was exactly the brief: F1 and F2, plus the nits; F3 untouched.
- Each fix was shown red first, and the claimed mutations reproduce.
- The comment at the fix site states why it is there.
- No drift.

**Owner questions:** none new. The only open item is tracking: F3 needs a
`TODO.md` entry on `main`.
